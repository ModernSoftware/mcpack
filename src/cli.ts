#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadProject } from './manifest.js';
import { MCPackRuntime } from './runtime.js';
import { createMcpServer } from './server.js';
import { serveHttp, bearerToken } from './http.js';

const usage = `Usage:
  mcpack validate <manifest>
  mcpack serve <manifest> [--transport stdio|http]
HTTP options:
  --host 127.0.0.1 --port 3000
  --token-env MCPACK_HTTP_TOKEN
  --allow-host <hostname>       Repeat for each allowed Host (no port)
  --allow-origin <origin>       Repeat for each browser origin
  --max-body-bytes 1048576 --max-in-flight 128
  --request-timeout-ms 60000 --shutdown-grace-ms 5000
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      transport: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'token-env': { type: 'string' },
      'allow-host': { type: 'string', multiple: true },
      'allow-origin': { type: 'string', multiple: true },
      'max-body-bytes': { type: 'string' },
      'max-in-flight': { type: 'string' },
      'request-timeout-ms': { type: 'string' },
      'shutdown-grace-ms': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  const [command, filename] = positionals;
  if (positionals.length !== 2 || !['validate', 'serve'].includes(command)) throw new Error(usage);
  if (command === 'validate') {
    if (Object.keys(values).length) throw new Error('validate does not accept serving options');
    await loadProject(filename);
    process.stdout.write('Manifest valid. Handler modules were not executed.\n');
    return;
  }
  const transport = values.transport ?? 'stdio';
  if (!['stdio', 'http'].includes(transport)) throw new Error('transport must be stdio or http');
  const diagnostic = (id: string, stream: string, text: string) =>
    process.stderr.write(`[${id}:${stream}] ${text}`);
  let close: () => Promise<void>;
  if (transport === 'http') {
    const tokenName = values['token-env'];
    const token = tokenName ? process.env[tokenName] : undefined;
    if (tokenName && !token)
      throw new Error(`Token environment variable ${tokenName} is empty or missing`);
    const number = (value: string | undefined) => (value === undefined ? undefined : Number(value));
    const host = await serveHttp(filename, {
      host: values.host,
      port: number(values.port),
      allowedHosts: values['allow-host'],
      allowedOrigins: values['allow-origin'],
      maxBodyBytes: number(values['max-body-bytes']),
      maxInFlight: number(values['max-in-flight']),
      requestTimeoutMs: number(values['request-timeout-ms']),
      shutdownGraceMs: number(values['shutdown-grace-ms']),
      authorize: token ? bearerToken(token) : undefined,
      diagnostic,
    });
    process.stderr.write(`MCPack HTTP listening at ${host.url}\n`);
    close = host.close;
  } else {
    if (Object.keys(values).some((key) => key !== 'transport'))
      throw new Error('HTTP options require --transport http');
    const runtime = await MCPackRuntime.load(filename, { diagnostic });
    await runtime.start();
    const handle = serveStdio(() => createMcpServer(runtime), {
      onerror: (error) => process.stderr.write(`MCP transport: ${error.message}\n`),
    });
    close = async () => {
      try {
        await handle.close();
      } finally {
        await runtime.close();
        process.stdin.pause();
      }
    };
  }
  let stopping: Promise<void> | undefined;
  const stop = () => {
    void (stopping ??= close()).catch((error) => {
      process.stderr.write(`Shutdown failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
  };
  if (transport === 'stdio') process.stdin.once('end', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
