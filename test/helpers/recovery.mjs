import assert from 'node:assert/strict';

import { mkdtemp, copyFile, writeFile, readFile, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { setTimeout as sleep } from 'node:timers/promises';

import { MCPackRuntime } from '../../dist/index.js';

export async function waitFor(check, message = 'Condition did not settle') {
  const deadline = performance.now() + 8000;

  while (performance.now() < deadline) {
    if (await check()) {
      return;
    }

    await sleep(10);
  }

  assert.fail(message);
}

export async function recoveryFixture(t, kind, workerOptions = {}, initialFlag) {
  const root = await mkdtemp(join(tmpdir(), 'mcpack-recovery-'));

  let runtime;

  t.after(async () => {
    await runtime?.close();

    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  const module = kind === 'node' ? 'recovery.mjs' : 'recovery.py';

  await copyFile(new URL(`../fixtures/${module}`, import.meta.url), join(root, module));

  const worker = {
    runtime: kind,
    module: `./${module}`,
    timeoutMs: 10000,
    recovery: {
      baseDelayMs: 100,
      maxDelayMs: 200,
      resetAfterMs: 60000,
      maxRestarts: 2,
    },
    ...workerOptions,
  };

  const manifest = {
    schemaVersion: 1,
    name: 'recovery',
    version: '1',
    workers: {
      primary: worker,
      secondary: {
        runtime: kind,
        module: `./${module}`,
      },
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

  const write = (name, content = '') => writeFile(join(root, name), content);

  const read = (name) => readFile(join(root, name), 'utf8').catch(() => '');

  if (initialFlag) {
    await write(`primary-${initialFlag}`);
  }

  runtime = await MCPackRuntime.load(filename);

  return {
    runtime,
    filename,
    write,
    read,
    health: () => runtime.health().workers.primary,
    ready: () => waitFor(() => runtime.health().ready, 'Workers did not recover'),
    calls: async () => (await read('primary-calls')).trim().split('\n').filter(Boolean),
  };
}

export const code = (expected) => (error) => error.code === expected;
