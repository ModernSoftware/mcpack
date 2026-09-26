import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, writeFile, readFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MCPackRuntime, loadProject } from '../dist/index.js';

for (const runtimeKind of ['node', 'python']) {
  const test = (name, ...args) => nodeTest(`${runtimeKind}: ${name}`, ...args);
  async function fixture(t, overrides = {}) {
    const root = await mkdtemp(join(tmpdir(), 'mcpack-'));
    const runtimes = [];
    // Windows keeps a live process's working directory locked. Stop every
    // runtime before removing its project, including after an assertion fails.
    t.after(async () => {
      await Promise.all(runtimes.map((runtime) => runtime.close()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const module = runtimeKind === 'node' ? 'handlers.mjs' : 'handlers.py';
    await copyFile(new URL(`./fixtures/${module}`, import.meta.url), join(root, module));
    const definition = {
      runtime: runtimeKind,
      module: `./${module}`,
      timeoutMs: 2000,
      ...overrides,
    };

    const manifest = {
      schemaVersion: 1,
      name: 'test',
      version: '1',
      workers: { primary: definition, secondary: { ...definition, timeoutMs: 3000 } },
      tools: ['primary', 'secondary'].map((worker) => ({
        name: worker,
        worker,
        handler: 'probe',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string' }, delay: { type: 'integer', minimum: 0 } },
          additionalProperties: false,
        },
      })),
    };

    const path = join(root, 'mcpack.json');
    await writeFile(path, JSON.stringify(manifest));
    const loadRuntime = async () => {
      const runtime = await MCPackRuntime.load(path);
      runtimes.push(runtime);
      return runtime;
    };
    const runtime = await loadRuntime();

    return { runtime, root, path, manifest, loadRuntime };
  }
  const code = (expected) => (error) => error.code === expected;

  test('worker state persists; named workers have separate processes and run concurrently', async (t) => {
    const { runtime } = await fixture(t, { maxConcurrent: 2 });
    await runtime.start();
    
    // Test that state persists across sequential calls
    const sequential1 = await runtime.callTool('primary');
    const sequential2 = await runtime.callTool('primary');
    assert.equal(sequential2.structuredContent.count, 2);
    
    // Now test concurrent execution
    const first = runtime.callTool('primary', { delay: 150 });
    const second = runtime.callTool('primary');
    
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // Because they run concurrently, the exact ordering of 'count' updates 
    // depends on the worker's asynchronous scheduling. However, both should
    // share the same PID.
    assert.equal(firstResult.structuredContent.pid, secondResult.structuredContent.pid);

    const other = await runtime.callTool('secondary');

    assert.notEqual(firstResult.structuredContent.pid, other.structuredContent.pid);

    let slowFinished = false;

    const slow = runtime.callTool('primary', { delay: 200 }).then(() => {
      slowFinished = true;
    });

    await runtime.callTool('secondary');
    assert.equal(slowFinished, false);
    await slow;
  });

  test('FIFO, bounded queue and queued cancellation leave active worker usable', async (t) => {
    const { runtime } = await fixture(t, { maxQueue: 1, maxConcurrent: 1 });
    await runtime.start();
    const active = runtime.callTool('primary', { delay: 150 });
    const controller = new AbortController();
    const queued = runtime.callTool('primary', {}, controller.signal);
    const cancelled = assert.rejects(queued, code('CANCELLED'));
    
    // We expect the third call to fail immediately with QUEUE_FULL because:
    // 1 call is active, 1 call is queued (filling the maxQueue of 1)
    await assert.rejects(runtime.callTool('primary'), code('QUEUE_FULL'));
    
    controller.abort();
    await cancelled;
    await active;
    assert.equal((await runtime.callTool('primary')).structuredContent.count, 2);
  });

  test('active timeout fails queued work without retry; other worker survives', async (t) => {
    const { runtime } = await fixture(t, { timeoutMs: 100, maxConcurrent: 1 });
    await runtime.start();

    const hung = assert.rejects(
      runtime.callTool('primary', { action: 'hang' }),
      code('DEADLINE_EXCEEDED'),
    );

    const queued = assert.rejects(runtime.callTool('primary'), code('WORKER_UNAVAILABLE'));
    await Promise.all([hung, queued]);
    await assert.rejects(runtime.callTool('primary'), code('WORKER_UNAVAILABLE'));
    assert.equal((await runtime.callTool('secondary')).structuredContent.count, 1);
  });

  test('active cancellation retires worker and queued requests settle', async (t) => {
    const { runtime } = await fixture(t, { maxConcurrent: 1 });
    await runtime.start();
    const controller = new AbortController();

    const active = assert.rejects(
      runtime.callTool('primary', { action: 'hang' }, controller.signal),
      code('CANCELLED'),
    );

    const queued = assert.rejects(runtime.callTool('primary'), code('WORKER_UNAVAILABLE'));
    controller.abort();
    await Promise.all([active, queued]);
  });

  test('worker crash is isolated and requests do not hang', async (t) => {
    const { runtime } = await fixture(t);
    await runtime.start();
    await assert.rejects(runtime.callTool('primary', { action: 'crash' }), code('WORKER_EXITED'));
    await runtime.callTool('secondary');
  });

  test('validation, private exceptions and business errors are distinct', async (t) => {
    const { runtime } = await fixture(t);
    await runtime.start();
    await assert.rejects(runtime.callTool('primary', { delay: -1 }), code('INVALID_ARGUMENTS'));
    await assert.rejects(runtime.callTool('missing'), code('NOT_FOUND'));
    await assert.rejects(
      runtime.callTool('primary', { action: 'invalid' }),
      code('INVALID_RESULT'),
    );

    await assert.rejects(
      runtime.callTool('primary', { action: 'throw' }),
      (error) => error.code === 'HANDLER_FAILED' && !error.message.includes('PRIVATE_EXCEPTION'),
    );

    await assert.rejects(runtime.callTool('primary', { action: 'bigint' }), code('INVALID_RESULT'));
    assert.equal((await runtime.callTool('primary', { action: 'business' })).isError, true);
    await runtime.callTool('primary');
  });

  test('environment forwarding is explicit', async (t) => {
    process.env.MCPACK_TEST_INHERITED = 'allowed';
    process.env.MCPACK_TEST_HIDDEN = 'hidden';

    t.after(() => {
      delete process.env.MCPACK_TEST_INHERITED;
      delete process.env.MCPACK_TEST_HIDDEN;
    });

    const { runtime } = await fixture(t, {
      inheritEnv: ['MCPACK_TEST_INHERITED'],
      env: { MCPACK_TEST_EXPLICIT: 'override' },
    });

    await runtime.start();
    const result = await runtime.callTool('primary', { action: 'env' });

    assert.deepEqual(JSON.parse(result.content[0].text), {
      inherited: 'allowed',
      explicit: 'override',
    });
  });

  test('graceful shutdown calls factory cleanup and is idempotent', async (t) => {
    const { runtime, root, path, manifest, loadRuntime } = await fixture(t);
    const marker = join(root, 'closed.txt');
    manifest.workers.primary.config = { marker };
    await writeFile(path, JSON.stringify(manifest));
    const configured = await loadRuntime();
    await configured.start();
    await configured.close();
    await configured.close();
    assert.equal(await readFile(marker, 'utf8'), 'closed');
    await assert.rejects(configured.callTool('primary'), code('RUNTIME_CLOSED'));
    await runtime.close();
  });

  test('startup failure rolls back all workers', async (t) => {
    const { runtime } = await fixture(t, { export: 'doesNotExist' });
    await assert.rejects(runtime.start(), code('STARTUP_FAILED'));
    await runtime.close();
  });

  test('manifest rejects collisions, unknown bindings and paths outside project', async (t) => {
    const { path, manifest } = await fixture(t);
    manifest.tools.push(manifest.tools[0]);
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(loadProject(path), code('INVALID_MANIFEST'));
    manifest.tools.pop();
    manifest.tools[0].worker = 'missing';
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(loadProject(path), code('INVALID_MANIFEST'));
    manifest.tools[0].worker = 'primary';
    manifest.workers.primary.module = resolve('test/fixtures/handlers.mjs');
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(loadProject(path), code('INVALID_MANIFEST'));
  });

  test('hung startup is bounded and cleaned up', { timeout: 5000 }, async (t) => {
    const { runtime } = await fixture(t, { export: 'neverReady', startupTimeoutMs: 100 });
    await assert.rejects(runtime.start(), code('STARTUP_FAILED'));
    await runtime.close();
  });

  test(
    'shutdown forces hung handlers to exit and rejects pending callers',
    { timeout: 5000 },
    async (t) => {
      const { runtime } = await fixture(t, { shutdownTimeoutMs: 100 });
      await runtime.start();

      const active = assert.rejects(
        runtime.callTool('primary', { action: 'hang' }),
        code('RUNTIME_CLOSED'),
      );

      const queued = assert.rejects(runtime.callTool('primary'), code('RUNTIME_CLOSED'));
      await runtime.close();
      await Promise.all([active, queued]);
    },
  );

  test('shutdown forces hung cleanup hooks to exit', { timeout: 5000 }, async (t) => {
    const { runtime } = await fixture(t, { config: { hangOnClose: true }, shutdownTimeoutMs: 100 });
    await runtime.start();
    await runtime.close();
  });

  // Exercises teardown with two live runtimes, rather than closing them in the test.
  test('fixture cleanup stops all registered runtimes before removing their project', async (t) => {
    let projectRoot;
    const pids = [];
    await t.test('leave both runtimes running for teardown', async (child) => {
      const { runtime, root, loadRuntime } = await fixture(child);
      projectRoot = root;
      const second = await loadRuntime();
      await Promise.all([runtime.start(), second.start()]);
      for (const instance of [runtime, second]) {
        for (const worker of ['primary', 'secondary']) {
          pids.push((await instance.callTool(worker)).structuredContent.pid);
        }
      }
    });
    await assert.rejects(access(projectRoot), { code: 'ENOENT' });
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });

  if (runtimeKind === 'python') {
    test(
      'project-relative virtual environment with spaces is used',
      { timeout: 20000 },
      async (t) => {
        const { root, path, manifest, loadRuntime } = await fixture(t);
        const environment = join(root, 'python environment');
        await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', [
          '-m',
          'venv',
          '--without-pip',
          environment,
        ]);
        manifest.workers.primary.executable =
          process.platform === 'win32'
            ? './python environment/Scripts/python.exe'
            : './python environment/bin/python';
        await writeFile(path, JSON.stringify(manifest));
        const runtime = await loadRuntime();
        await runtime.start();
        assert.equal(
          await realpath(
            (await runtime.callTool('primary', { action: 'interpreter' })).structuredContent.prefix,
          ),
          await realpath(environment),
        );
      },
    );

    test(
      'missing interpreter fails startup and closes without hanging',
      { timeout: 5000 },
      async (t) => {
        const { runtime } = await fixture(t, { executable: './missing-python-executable' });
        await assert.rejects(runtime.start(), code('WORKER_UNAVAILABLE'));
        await runtime.close();
      },
    );

    test('async factory, sync handler, invalid JSON and broken framing', async (t) => {
      const { path, manifest, loadRuntime } = await fixture(t, { export: 'async_factory' });
      manifest.tools.push({
        name: 'sync',
        worker: 'primary',
        handler: 'sync_probe',
        inputSchema: { type: 'object' },
      });
      await writeFile(path, JSON.stringify(manifest));
      const runtime = await loadRuntime();
      await runtime.start();
      assert.equal((await runtime.callTool('sync')).content[0].text, 'synchronous');
      await assert.rejects(runtime.callTool('primary', { action: 'nan' }), code('INVALID_RESULT'));
      await assert.rejects(
        runtime.callTool('primary', { action: 'large_integer' }),
        code('INVALID_RESULT'),
      );
      await runtime.callTool('primary');
      await assert.rejects(
        runtime.callTool('primary', { action: 'malformed' }),
        code('WORKER_PROTOCOL_ERROR'),
      );
      await runtime.callTool('secondary');
    });

    test('blocking sync handler has a bounded shutdown', { timeout: 5000 }, async (t) => {
      const { path, manifest, loadRuntime } = await fixture(t, { shutdownTimeoutMs: 100 });
      manifest.tools[0].handler = 'sync_probe';
      await writeFile(path, JSON.stringify(manifest));
      const runtime = await loadRuntime();
      await runtime.start();
      const active = assert.rejects(
        runtime.callTool('primary', { action: 'hang' }),
        code('RUNTIME_CLOSED'),
      );
      await runtime.close();
      await active;
    });
  }
}
