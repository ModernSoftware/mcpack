import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MCPackRuntime } from './runtime.js';
import { createMcpServer } from './server.js';
import type { Diagnostic } from './process-worker.js';

export interface HttpAuthorizationContext {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly signal: AbortSignal;
}

export interface HttpOptions {
  host?: string;
  port?: number;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  maxInFlight?: number;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  authorize?: (request: HttpAuthorizationContext) => boolean | Promise<boolean>;
  diagnostic?: Diagnostic;
}

const settingsSchema = z
  .object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(3000),
    allowedHosts: z.array(z.string().min(1)).min(1).default(['127.0.0.1', 'localhost', '[::1]']),
    allowedOrigins: z.array(z.string().url()).default([]),
    maxBodyBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024)
      .default(1024 * 1024),
    maxInFlight: z.number().int().min(1).max(10000).default(128),
    requestTimeoutMs: z.number().int().min(1).max(600000).default(60000),
    shutdownGraceMs: z.number().int().min(0).max(30000).default(5000),
  })
  .strict();

/** Simple service-token gate; OAuth and per-user handler identity are not implied. */
export function bearerToken(token: string): NonNullable<HttpOptions['authorize']> {
  if (!token) throw new Error('Bearer token must not be empty');
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const expected = hash(token);
  return ({ headers }) => {
    const match = /^Bearer (.+)$/i.exec(headers.get('authorization') ?? '');
    return Boolean(match && timingSafeEqual(hash(match[1]), expected));
  };
}

function reply(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: message }));
}

class HttpRejection extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Request aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Do not destroy the request when rejecting a streamed oversized body: send 413 first.
  for await (const data of request.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    bytes += chunk.length;
    if (bytes > limit) throw new HttpRejection(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Owns one shared native runtime and one stateless HTTP listener. */
export async function serveHttp(filename: string, options: HttpOptions = {}) {
  const { authorize, diagnostic, ...input } = options;
  const settings = settingsSchema.parse(input);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(settings.host);
  if (!loopback && (!authorize || !options.allowedHosts?.length)) {
    throw new Error('Non-loopback HTTP requires authorize and explicit allowedHosts');
  }
  const allowedHosts = new Set(
    settings.allowedHosts.map((host) => {
      const parsed = new URL(`http://${host}`);
      if (
        parsed.host !== host.toLowerCase() ||
        parsed.port ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/'
      ) {
        throw new Error('allowedHosts must contain hostnames without ports, paths, or credentials');
      }
      return parsed.hostname;
    }),
  );
  const allowedOrigins = new Set(
    settings.allowedOrigins.map((origin) => {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
        throw new Error('allowedOrigins must contain exact HTTP(S) origins');
      }
      return origin;
    }),
  );
  const runtime = await MCPackRuntime.load(filename, { diagnostic });
  await runtime.start();
  const handler = createMcpHandler(
    (context) => createMcpServer(runtime, { signal: context.requestInfo?.signal }),
    {
      legacy: 'stateless',
      maxSubscriptions: 0,
    },
  );
  const active = new Set<AbortController>();
  let stopping = false;
  let closing: Promise<void> | undefined;
  let drained: (() => void) | undefined;

  const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
    const controller = new AbortController();
    let admitted = false;
    const disconnected = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once('close', disconnected);
    response.once('finish', () => {
      if (!request.complete) request.destroy();
    });
    const timer = setTimeout(() => {
      controller.abort();
      reply(response, 504, 'HTTP request deadline exceeded');
    }, settings.requestTimeoutMs);
    timer.unref();
    void (async () => {
      if (stopping) throw new HttpRejection(503, 'Server shutting down');
      const authority = request.headers.host;
      if (!authority) throw new HttpRejection(400, 'Host header required');
      let base: URL;
      try {
        base = new URL(`http://${authority}`);
      } catch {
        throw new HttpRejection(403, 'Host not allowed');
      }
      if (
        base.username ||
        base.password ||
        base.pathname !== '/' ||
        base.search ||
        base.hash ||
        !allowedHosts.has(base.hostname)
      ) {
        throw new HttpRejection(403, 'Host not allowed');
      }
      const origin = request.headers.origin;
      if (origin && origin !== base.origin && !allowedOrigins.has(origin)) {
        throw new HttpRejection(403, 'Origin not allowed');
      }
      // Origin-form URLs only; forwarded host/protocol headers are never trusted.
      if (!request.url?.startsWith('/') || request.url.startsWith('//'))
        throw new HttpRejection(400, 'Invalid request target');
      const url = new URL(request.url, base);
      if (url.origin !== base.origin) throw new HttpRejection(400, 'Invalid request target');
      if (request.method === 'GET' && ['/healthz', '/readyz'].includes(url.pathname)) {
        const ready = runtime.health().ready;
        response.writeHead(url.pathname === '/readyz' && !ready ? 503 : 200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify({ status: ready ? 'ready' : 'degraded' }));
        return;
      }
      if (url.pathname !== '/mcp') throw new HttpRejection(404, 'Not found');
      if (!['POST', 'GET', 'DELETE'].includes(request.method ?? '')) {
        response.setHeader('Allow', 'POST, GET, DELETE');
        throw new HttpRejection(405, 'Method not allowed');
      }
      if (active.size >= settings.maxInFlight)
        throw new HttpRejection(503, 'HTTP concurrency limit reached');
      active.add(controller);
      admitted = true;
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      if (
        authorize &&
        !(await abortable(
          Promise.resolve(
            authorize({ method: request.method!, url, headers, signal: controller.signal }),
          ),
          controller.signal,
        ))
      ) {
        response.setHeader('WWW-Authenticate', 'Bearer realm="mcpack"');
        throw new HttpRejection(401, 'Unauthorized');
      }
      controller.signal.throwIfAborted();
      if (Number(request.headers['content-length']) > settings.maxBodyBytes)
        throw new HttpRejection(413, 'Request body too large');
      if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')
        throw new HttpRejection(415, 'Content encoding not supported');
      const payload =
        request.method === 'POST' ? await body(request, settings.maxBodyBytes) : undefined;
      controller.signal.throwIfAborted();
      const webRequest = new Request(url, {
        method: request.method,
        headers,
        body: payload ? new Uint8Array(payload) : undefined,
        signal: controller.signal,
      });
      const result = await handler.fetch(webRequest);
      if (response.destroyed || response.writableEnded) {
        await result.body?.cancel();
        return;
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body)
        await pipeline(
          Readable.fromWeb(result.body as import('node:stream/web').ReadableStream),
          response,
        );
      else response.end();
    })()
      .catch((error) => {
        reply(
          response,
          error instanceof HttpRejection ? error.status : 500,
          error instanceof HttpRejection ? error.message : 'HTTP request failed',
        );
      })
      .finally(() => {
        clearTimeout(timer);
        response.off('close', disconnected);
        if (!request.complete) {
          response.once('finish', () => request.destroy());
          if (response.writableFinished) request.destroy();
        }
        if (admitted) active.delete(controller);
        if (!active.size) drained?.();
      });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = settings.requestTimeoutMs;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(settings.port, settings.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await handler.close();
    await runtime.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP listener has no address');
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;

  return {
    url: `http://${host}:${address.port}/mcp`,
    runtime,
    close(): Promise<void> {
      return (closing ??= (async () => {
        stopping = true;
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        let timer: NodeJS.Timeout | undefined;
        if (active.size)
          await new Promise<void>((resolve) => {
            drained = resolve;
            timer = setTimeout(resolve, settings.shutdownGraceMs);
          });
        clearTimeout(timer);
        for (const controller of active) controller.abort();
        // Closing workers settles queued/active calls even if a handler ignores abort.
        try {
          await runtime.close();
          await handler.close();
        } finally {
          server.closeAllConnections();
          await closed;
        }
      })());
    },
  };
}
