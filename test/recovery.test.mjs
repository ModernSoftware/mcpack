import test from 'node:test';

import assert from 'node:assert/strict';

import { setTimeout as sleep } from 'node:timers/promises';

import { recoveryFixture, waitFor, code } from './helpers/recovery.mjs';

for (const kind of ['node', 'python']) {
  test(`${kind}: invalid recovery policies fail manifest validation`, async (t) => {
    for (const recovery of [
      false,
      null,
      { maxRestarts: 0 },
      { maxRestarts: 101 },
      { baseDelayMs: 0 },
      {
        baseDelayMs: 20,
        maxDelayMs: 10,
      },
      { resetAfterMs: 0 },
      { resetAfterMs: 86400001 },
      { maxRestarts: 1.5 },
      { unknown: true },
    ]) {
      await assert.rejects(recoveryFixture(t, kind, { recovery }), code('INVALID_MANIFEST'));
    }
  });

  test(`${kind}: recovery replaces a dead process, resets state and never replays side effects`, async (t) => {
    const f = await recoveryFixture(t, kind);

    await f.runtime.start();

    const old = await f.runtime.callTool('primary');

    const crash = assert.rejects(
      f.runtime.callTool('primary', {
        id: 'write-once',
        action: 'crash',
        gate: true,
      }),
      code('WORKER_EXITED'),
    );

    await waitFor(async () => (await f.calls()).includes('write-once'));

    const queued = assert.rejects(
      f.runtime.callTool('primary', { id: 'never-dispatched' }),
      code('WORKER_EXITED'),
    );

    await f.write('primary-release');

    await Promise.all([crash, queued]);

    assert.equal(f.health().state, 'restarting');

    assert.equal(f.runtime.health().ready, false);

    await assert.rejects(f.runtime.callTool('primary'), code('WORKER_UNAVAILABLE'));

    await f.runtime.callTool('secondary');

    await f.ready();

    const replacement = await f.runtime.callTool('primary');

    assert.notEqual(replacement.structuredContent.pid, old.structuredContent.pid);

    assert.throws(() => process.kill(old.structuredContent.pid, 0), { code: 'ESRCH' });

    assert.equal(replacement.structuredContent.count, 1);

    assert.equal((await f.calls()).filter((x) => x === 'write-once').length, 1);

    assert.equal((await f.calls()).includes('never-dispatched'), false);

    assert.equal(await f.read('primary-overlap'), '');

    assert.equal(f.health().recovery.restartCount, 1);

    assert.equal(f.health().recovery.generation, 2);
  });

  for (const failure of ['cancel', 'timeout', 'protocol']) {
    test(`${kind}: ${failure} recovers without replaying other executing calls`, async (t) => {
      const f = await recoveryFixture(t, kind, {
        maxConcurrent: 2,
        timeoutMs: failure === 'timeout' ? 1500 : 10000,
      });

      await f.runtime.start();

      const controller = new AbortController();

      const first = assert.rejects(
        f.runtime.callTool(
          'primary',
          {
            id: 'first',
            action: failure === 'protocol' ? 'protocol' : 'hang',
            gate: true,
          },
          controller.signal,
        ),
        code(
          {
            cancel: 'CANCELLED',
            timeout: 'DEADLINE_EXCEEDED',
            protocol: 'WORKER_PROTOCOL_ERROR',
          }[failure],
        ),
      );

      await waitFor(async () => (await f.calls()).includes('first'));

      const second = assert.rejects(
        f.runtime.callTool('primary', {
          id: 'second',
          action: 'hang',
        }),
        code(failure === 'protocol' ? 'WORKER_PROTOCOL_ERROR' : 'WORKER_UNAVAILABLE'),
      );

      await waitFor(async () => (await f.calls()).includes('second'));

      if (failure === 'cancel') {
        controller.abort();
      }

      if (failure === 'protocol') {
        await f.write('primary-release');
      }

      await Promise.all([first, second]);

      await f.ready();

      assert.deepEqual(await f.calls(), ['first', 'second']);

      assert.equal(f.health().recovery.restartCount, 1);

      await f.runtime.callTool('primary');
    });
  }

  test(`${kind}: handler failures do not restart; repeated crashes exhaust the budget`, async (t) => {
    const f = await recoveryFixture(t, kind);

    await f.runtime.start();

    await assert.rejects(
      f.runtime.callTool('primary', { action: 'throw' }),
      code('HANDLER_FAILED'),
    );

    assert.equal(f.health().recovery.restartCount, 0);

    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        f.runtime.callTool('primary', { action: 'crash' }),
        code('WORKER_EXITED'),
      );

      if (i < 2) {
        await f.ready();
      }
    }

    assert.equal(f.health().state, 'failed');

    assert.equal(f.health().recovery.exhausted, true);

    assert.equal(f.health().recovery.restartCount, 2);

    await assert.rejects(f.runtime.callTool('primary'), code('WORKER_UNAVAILABLE'));

    await f.runtime.callTool('secondary');
  });

  test(`${kind}: stable ready interval resets the consecutive restart budget`, async (t) => {
    const f = await recoveryFixture(t, kind, {
      recovery: {
        maxRestarts: 1,
        baseDelayMs: 20,
        maxDelayMs: 20,
        resetAfterMs: 100,
      },
    });

    await f.runtime.start();

    for (let i = 0; i < 2; i++) {
      await sleep(150);

      await assert.rejects(
        f.runtime.callTool('primary', { action: 'crash' }),
        code('WORKER_EXITED'),
      );

      await f.ready();
    }

    assert.equal(f.health().recovery.restartCount, 2);

    assert.equal(f.health().recovery.attempts, 1);

    assert.equal(f.health().recovery.exhausted, false);
  });

  for (const flag of ['fail-start', 'hang-start']) {
    test(`${kind}: replacement ${flag} is bounded and initial ${flag} never retries`, async (t) => {
      const initial = await recoveryFixture(t, kind, { startupTimeoutMs: 1500 }, flag);

      await assert.rejects(initial.runtime.start());

      assert.equal(initial.health().recovery.restartCount, 0);

      const f = await recoveryFixture(t, kind, { startupTimeoutMs: 1500 });

      await f.runtime.start();

      await f.write(`primary-${flag}`);

      await assert.rejects(
        f.runtime.callTool('primary', { action: 'crash' }),
        code('WORKER_EXITED'),
      );

      await waitFor(() => f.health().state === 'failed');

      assert.equal(f.health().recovery.exhausted, true);

      assert.equal(f.health().recovery.restartCount, 2);

      assert.equal(f.health().recovery.lastFailureCode, 'STARTUP_FAILED');

      assert.equal(JSON.stringify(f.health()).includes('PRIVATE'), false);
    });
  }

  test(`${kind}: close cancels backoff without creating another process`, async (t) => {
    const f = await recoveryFixture(t, kind, {
      recovery: {
        baseDelayMs: 1000,
        maxDelayMs: 1000,
      },
    });

    await f.runtime.start();

    await assert.rejects(f.runtime.callTool('primary', { action: 'crash' }), code('WORKER_EXITED'));

    await waitFor(() => f.health().recovery.nextRestartAt !== null);

    const started = performance.now();

    await Promise.all([f.runtime.close(), f.runtime.close()]);

    assert.ok(performance.now() - started < 1000);

    assert.equal(f.health().state, 'closed');

    assert.equal(f.health().recovery.restartCount, 0);

    assert.equal(f.health().recovery.nextRestartAt, null);
  });

  test(`${kind}: close during replacement startup stops it and does not schedule another`, async (t) => {
    const f = await recoveryFixture(t, kind, { shutdownTimeoutMs: 100 });

    await f.runtime.start();

    await f.write('primary-hang-start');

    await assert.rejects(f.runtime.callTool('primary', { action: 'crash' }), code('WORKER_EXITED'));

    await waitFor(async () => (await f.read('primary-starts')).trim().split('\n').length === 2);

    await f.runtime.close();

    assert.equal(f.health().state, 'closed');

    assert.equal(f.health().recovery.restartCount, 1);

    for (const pid of (await f.read('primary-starts')).trim().split('\n'))
      assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' });
  });
}
