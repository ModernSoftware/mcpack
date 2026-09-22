#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadProject } from './manifest.js';
import { MCPackRuntime } from './runtime.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const [command, filename, ...extra] = process.argv.slice(2);
  if (!filename || extra.length || !['validate', 'serve'].includes(command)) {
    throw new Error('Usage: mcpack <validate|serve> <path/to/mcpack.json>');
  }
  if (command === 'validate') {
    await loadProject(filename);
    process.stdout.write('Manifest valid. Handler modules were not executed.\n');
    return;
  }
  const runtime = await MCPackRuntime.load(filename, {
    diagnostic: (id, stream, text) => process.stderr.write(`[${id}:${stream}] ${text}`),
  });
  await runtime.start();
  const handle = serveStdio(() => createMcpServer(runtime), {
    onerror: (error) => process.stderr.write(`MCP transport: ${error.message}\n`),
  });
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      await handle.close();
      await runtime.close();
      process.stdin.pause();
    })());
  process.stdin.once('end', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
