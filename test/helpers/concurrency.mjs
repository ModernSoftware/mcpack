import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { MCPackRuntime } from '../../dist/index.js';

export async function concurrencyFixture(t, kind, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mcpack-concurrency-'));
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const module = kind === 'node' ? 'concurrent.mjs' : 'concurrent.py';
  await copyFile(new URL(`../fixtures/${module}`, import.meta.url), join(root, module));
  const worker = { runtime: kind, module: `./${module}`, timeoutMs: 10000, ...overrides };
  const manifest = {
    schemaVersion: 1,
    name: 'concurrency',
    version: '1',
    workers: { primary: worker, secondary: worker },
    tools: [
      { name: 'probe', worker: 'primary', handler: 'probe', inputSchema: { type: 'object' } },
      { name: 'sync', worker: 'primary', handler: 'sync', inputSchema: { type: 'object' } },
      { name: 'other', worker: 'secondary', handler: 'probe', inputSchema: { type: 'object' } },
    ],
    resources: [{ name: 'resource', uri: 'review://resource', worker: 'primary', handler: 'read' }],
    prompts: [{ name: 'prompt', worker: 'primary', handler: 'render' }],
  };
  const filename = join(root, 'mcpack.json');
  await writeFile(filename, JSON.stringify(manifest));
  const diagnostics = [];
  runtime = await MCPackRuntime.load(filename, {
    diagnostic: (_id, _stream, text) => diagnostics.push(text),
  });
  await runtime.start();
  const read = (name) => readFile(join(root, name), 'utf8').catch(() => undefined);
  return {
    runtime,
    diagnostics,
    read,
    release: (id) => writeFile(join(root, `release-${id}`), 'release'),
    async started(id) {
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const requestId = await read(`started-${id}`);
        if (requestId) return requestId;
        await sleep(5);
      }
      assert.fail(`Handler ${id} did not start`);
    },
  };
}

export const errorCode = (code) => (error) => error.code === code;
