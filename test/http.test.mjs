import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as rawRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveHttp, bearerToken } from '../dist/index.js';

async function connect(t, host, mode = 'auto', headers = {}) {
  const client = new Client({ name: 'http-test', version: '1' }, { versionNegotiation: { mode } });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers } }),
  );
  return client;
}

async function fixture(t, options = {}, workerOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mcpack-http-'));
  let host;
  t.after(async () => {
    await host?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await copyFile(new URL('./fixtures/handlers.mjs', import.meta.url), join(root, 'handlers.mjs'));
  const manifest = {
    schemaVersion: 1,
    name: 'http-test',
    version: '1',
    workers: {
      primary: {
        runtime: 'node',
        module: './handlers.mjs',
        timeoutMs: 10000,
        shutdownTimeoutMs: 100,
        ...workerOptions,
      },
      secondary: { runtime: 'node', module: './handlers.mjs' },
    },
    tools: ['primary', 'secondary'].map((worker) => ({
      name: worker,
      worker,
      handler: 'probe',
      inputSchema: { type: 'object' },
    })),
  };
  const filename = join(root, 'mcpack.json');
  await writeFile(filename, JSON.stringify(manifest));
  host = await serveHttp(filename, { port: 0, ...options });
  return host;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const mode of ['auto', 'legacy']) {
  test(`HTTP ${mode}: mixed capabilities, authentication on each request, persistent shared state`, async (t) => {
    const host = await serveHttp(resolve('examples/mixed/mcpack.json'), {
      port: 0,
      authorize: bearerToken('test-token'),
    });
    t.after(() => host.close());
    const client = await connect(t, host, mode, { authorization: 'Bearer test-token' });
    assert.deepEqual(
      (await client.listTools()).tools.map((x) => x.name),
      ['greet', 'summarize'],
    );
    assert.equal(
      (await client.callTool({ name: 'greet', arguments: { name: 'HTTP' } })).content[0].text,
      'Hello, HTTP!',
    );
    assert.equal(
      (await client.callTool({ name: 'summarize', arguments: { values: [2, 3] } }))
        .structuredContent.total,
      5,
    );
    assert.equal((await client.listResources()).resources.length, 1);
    assert.match(
      (await client.readResource({ uri: 'mcpack://mixed/guide' })).contents[0].text,
      /Python/,
    );
    assert.equal((await client.listPrompts()).prompts.length, 1);
    assert.match(
      (await client.getPrompt({ name: 'review', arguments: { summary: '5' } })).messages[0].content
        .text,
      /5/,
    );
    const other = await connect(t, host, mode, { authorization: 'Bearer test-token' });
    assert.equal(
      (await other.callTool({ name: 'greet', arguments: { name: 'Second' } })).structuredContent
        .calls,
      2,
    );
    await client.close();
    assert.equal(
      (await other.callTool({ name: 'greet', arguments: { name: 'Still alive' } }))
        .structuredContent.calls,
      3,
    );
    assert.equal((await fetch(host.url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal(
      (
        await fetch(host.url, {
          method: 'POST',
          headers: { authorization: 'Bearer wrong' },
          body: '{}',
        })
      ).status,
      401,
    );
    await other.close();
  });

  test(`HTTP ${mode}: disconnected active call retires only its worker`, async (t) => {
    const host = await fixture(t);
    const client = await connect(t, host, mode);
    const controller = new AbortController();
    const pending = assert.rejects(
      mode === 'legacy'
        ? fetch(host.url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 900,
              method: 'tools/call',
              params: { name: 'primary', arguments: { action: 'hang' } },
            }),
          }).then((response) => response.text())
        : client.callTool(
            { name: 'primary', arguments: { action: 'hang' } },
            { signal: controller.signal },
          ),
    );
    await waitFor(() => host.runtime.health().workers.primary.active);
    controller.abort();
    await pending;
    await waitFor(() => host.runtime.health().workers.primary.state === 'failed');
    assert.equal((await fetch(new URL('/readyz', host.url))).status, 503);
    assert.equal((await fetch(new URL('/healthz', host.url))).status, 200);
    await client.callTool({ name: 'secondary' });
    await client.close();
  });
}

test('HTTP rejects bad hosts/origins, limits known and streamed bodies, and rejects malformed JSON', async (t) => {
  const host = await fixture(t, { maxBodyBytes: 128 });
  const badHost = await new Promise((resolve, reject) => {
    const req = rawRequest(
      host.url,
      { method: 'POST', headers: { host: 'evil.example' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(badHost, 403);
  assert.equal(
    (await fetch(host.url, { headers: { origin: 'https://evil.example' } })).status,
    403,
  );
  assert.equal((await fetch(host.url, { method: 'POST', body: 'x'.repeat(129) })).status, 413);
  const status = await new Promise((resolve, reject) => {
    const req = rawRequest(
      host.url,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.write('x'.repeat(70));
    req.end('x'.repeat(70));
  });
  assert.equal(status, 413);
  assert.equal(
    (
      await fetch(host.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{bad',
      })
    ).status,
    400,
  );
  assert.equal((await fetch(host.url, { method: 'PUT' })).status, 405);
  assert.equal((await fetch(new URL('/missing', host.url))).status, 404);
  assert.equal((await fetch(new URL('/readyz', host.url))).status, 200);
});

test('HTTP admission and timeout bound a stuck authorization hook', async (t) => {
  let entered = false;
  const host = await fixture(t, {
    maxInFlight: 1,
    requestTimeoutMs: 1000,
    authorize: () => {
      entered = true;
      return new Promise(() => {});
    },
  });
  const pending = fetch(host.url, { method: 'POST', body: '{}' });
  await waitFor(() => entered);
  assert.equal((await fetch(host.url, { method: 'POST', body: '{}' })).status, 503);
  assert.equal((await pending).status, 504);
  assert.equal(host.runtime.health().ready, true);
});

test(
  'HTTP bounded shutdown settles active work, closes workers and port; close is idempotent',
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t, { shutdownGraceMs: 50 });
    const client = await connect(t, host);
    const pid = (await client.callTool({ name: 'primary' })).structuredContent.pid;
    const pending = client
      .callTool({ name: 'primary', arguments: { action: 'hang' } })
      .catch(() => {});
    await waitFor(() => host.runtime.health().workers.primary.active);
    await Promise.all([host.close(), host.close()]);
    await pending;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(host.runtime.health().state, 'closed');
    await assert.rejects(fetch(host.url));
    await client.close();
  },
);

test('HTTP non-loopback binding requires explicit auth and hosts', async () => {
  await assert.rejects(
    serveHttp(resolve('examples/hello/mcpack.json'), { host: '0.0.0.0', port: 0 }),
    /Non-loopback/,
  );
  await assert.rejects(
    serveHttp(resolve('examples/hello/mcpack.json'), { allowedHosts: ['example.test/path'] }),
    /allowedHosts/,
  );
});

test('HTTP request deadline terminates a stuck worker and keeps another worker usable', async (t) => {
  const host = await fixture(t, { requestTimeoutMs: 1000 });
  const client = await connect(t, host);
  await assert.rejects(client.callTool({ name: 'primary', arguments: { action: 'hang' } }));
  await waitFor(() => host.runtime.health().workers.primary.state === 'failed');
  await client.callTool({ name: 'secondary' });
  await client.close();
});

test('HTTP incomplete request body is bounded by the request deadline', async (t) => {
  const host = await fixture(t, { requestTimeoutMs: 100 });
  const status = await new Promise((resolve, reject) => {
    const req = rawRequest(
      host.url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 10 } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.write('{');
  });
  assert.equal(status, 504);
});
