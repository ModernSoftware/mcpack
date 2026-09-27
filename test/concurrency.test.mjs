import test from 'node:test';
import assert from 'node:assert/strict';
import { concurrencyFixture, errorCode } from './helpers/concurrency.mjs';

for (const kind of ['node', 'python']) {
  test(`${kind}: invalid concurrency settings are rejected`, async (t) => {
    for (const value of [0, -1, 1.5, 1001, '2']) {
      await assert.rejects(
        concurrencyFixture(t, kind, { maxConcurrent: value }),
        errorCode('INVALID_MANIFEST'),
      );
    }
  });

  test(`${kind}: shutdown remains bounded with multiple noncooperative calls`, async (t) => {
    const f = await concurrencyFixture(t, kind, { maxConcurrent: 2, shutdownTimeoutMs: 100 });
    const calls = ['first', 'second'].map((id) =>
      assert.rejects(f.runtime.callTool('probe', { id }), errorCode('RUNTIME_CLOSED')),
    );
    await Promise.all([f.started('first'), f.started('second')]);
    const start = performance.now();
    await f.runtime.close();
    await Promise.all(calls);
    assert.ok(performance.now() - start < 3000, 'shutdown must force a stuck worker to exit');
    assert.equal(await f.read('finished-first'), undefined);
    assert.equal(await f.read('finished-second'), undefined);
  });

  test(`${kind}: default remains sequential and health retains its boolean active flag`, async (t) => {
    const f = await concurrencyFixture(t, kind);
    const first = f.runtime.callTool('probe', { id: 'first' });
    await f.started('first');
    const second = f.runtime.callTool('probe', { id: 'second' });
    const health = f.runtime.health().workers.primary;
    assert.equal(health.active, true);
    assert.equal(health.activeCount, 1);
    assert.equal(health.queued, 1);
    assert.equal(await f.read('started-second'), undefined);
    await f.release('first');
    await first;
    await f.started('second');
    await f.release('second');
    await second;
    assert.equal(f.runtime.health().workers.primary.active, false);
  });

  test(`${kind}: concurrent calls overlap, respect capacity/FIFO, and correlate out-of-order results`, async (t) => {
    const f = await concurrencyFixture(t, kind, { maxConcurrent: 2, maxQueue: 2 });
    const first = f.runtime.callTool('probe', { id: 'first' });
    const second = f.runtime.callTool('probe', { id: 'second' });
    const ids = await Promise.all([f.started('first'), f.started('second')]);
    assert.notEqual(ids[0], ids[1]);
    const third = f.runtime.callTool('probe', { id: 'third' });
    const fourth = f.runtime.callTool('probe', { id: 'fourth' });
    assert.equal(f.runtime.health().workers.primary.activeCount, 2);
    assert.equal(f.runtime.health().workers.primary.queued, 2);
    await assert.rejects(f.runtime.callTool('probe', { id: 'overflow' }), errorCode('QUEUE_FULL'));
    await f.release('second');
    assert.deepEqual((await second).structuredContent, { id: 'second', requestId: ids[1] });
    await f.started('third');
    assert.equal(await f.read('started-fourth'), undefined);
    assert.equal(await f.read('finished-first'), undefined);
    await f.release('third');
    await third;
    await f.started('fourth');
    await f.release('fourth');
    await fourth;
    await f.release('first');
    assert.deepEqual((await first).structuredContent, { id: 'first', requestId: ids[0] });
  });

  test(`${kind}: zero waiting capacity still admits free execution slots`, async (t) => {
    const f = await concurrencyFixture(t, kind, { maxConcurrent: 2, maxQueue: 0 });
    const first = f.runtime.callTool('probe', { id: 'first' });
    const second = f.runtime.callTool('probe', { id: 'second' });
    await Promise.all([f.started('first'), f.started('second')]);
    await assert.rejects(f.runtime.callTool('probe', { id: 'full' }), errorCode('QUEUE_FULL'));
    await f.release('second');
    await second;
    const next = f.runtime.callTool('probe', { id: 'next' });
    await f.started('next');
    await Promise.all([f.release('first'), f.release('next')]);
    await Promise.all([first, next]);
  });

  test(`${kind}: queued cancellation preserves both executing calls`, async (t) => {
    const f = await concurrencyFixture(t, kind, { maxConcurrent: 2 });
    const first = f.runtime.callTool('probe', { id: 'first' });
    const second = f.runtime.callTool('probe', { id: 'second' });
    await Promise.all([f.started('first'), f.started('second')]);
    const controller = new AbortController();
    const queued = assert.rejects(
      f.runtime.callTool('probe', { id: 'queued' }, controller.signal),
      errorCode('CANCELLED'),
    );
    controller.abort();
    await queued;
    assert.equal(f.runtime.health().workers.primary.activeCount, 2);
    assert.equal(f.runtime.health().workers.primary.queued, 0);
    await Promise.all([f.release('first'), f.release('second')]);
    await Promise.all([first, second]);
    assert.equal(await f.read('started-queued'), undefined);
  });

  for (const failure of ['cancel', 'timeout', 'crash']) {
    test(`${kind}: ${failure} retires all executing/queued work without retry; another worker survives`, async (t) => {
      const f = await concurrencyFixture(t, kind, {
        maxConcurrent: 2,
        timeoutMs: failure === 'timeout' ? 1500 : 10000,
      });
      const controller = new AbortController();
      const first = assert.rejects(
        f.runtime.callTool('probe', { id: 'first', crash: failure === 'crash' }, controller.signal),
        errorCode(
          { cancel: 'CANCELLED', timeout: 'DEADLINE_EXCEEDED', crash: 'WORKER_EXITED' }[failure],
        ),
      );
      await f.started('first');
      const collateralCode = failure === 'crash' ? 'WORKER_EXITED' : 'WORKER_UNAVAILABLE';
      const second = assert.rejects(
        f.runtime.callTool('probe', { id: 'second' }),
        errorCode(collateralCode),
      );
      await f.started('second');
      const queued = assert.rejects(
        f.runtime.callTool('probe', { id: 'queued' }),
        errorCode(collateralCode),
      );
      if (failure === 'cancel') controller.abort();
      if (failure === 'crash') await f.release('first');
      await Promise.all([first, second, queued]);
      assert.equal(await f.read('started-queued'), undefined);
      assert.equal(f.runtime.health().workers.primary.state, 'failed');
      await f.release('other');
      await f.runtime.callTool('other', { id: 'other' });
    });
  }

  test(`${kind}: graceful close drains concurrent calls and runs cleanup exactly once`, async (t) => {
    const f = await concurrencyFixture(t, kind, { maxConcurrent: 2 });
    const calls = ['first', 'second'].map((id) =>
      assert.rejects(
        f.runtime.callTool('probe', { id, cooperate: true }),
        errorCode('RUNTIME_CLOSED'),
      ),
    );
    await Promise.all([f.started('first'), f.started('second')]);
    await Promise.all([f.runtime.close(), f.runtime.close()]);
    await Promise.all(calls);
    assert.equal(await f.read('finished-first'), 'finished');
    assert.equal(await f.read('finished-second'), 'finished');
    assert.equal(await f.read('closed-primary'), 'closed\n');
    assert.equal(await f.read('closed-secondary'), 'closed\n');
    assert.equal(f.diagnostics.join('').includes('dictionary changed size'), false);
  });

  test(`${kind}: tools, resources and prompts share execution slots`, async (t) => {
    const f = await concurrencyFixture(t, kind, { maxConcurrent: 2 });
    const tool = f.runtime.callTool('probe', { id: 'tool' });
    const resource = f.runtime.readResource('review://resource');
    await Promise.all([f.started('tool'), f.started('resource')]);
    const prompt = f.runtime.getPrompt('prompt');
    assert.equal(f.runtime.health().workers.primary.queued, 1);
    await f.release('resource');
    assert.equal((await resource).contents[0].text, 'resource');
    await f.started('prompt');
    await Promise.all([f.release('tool'), f.release('prompt')]);
    await tool;
    assert.equal((await prompt).messages[0].content.text, 'prompt');
  });

  test(`${kind}: handler failure affects only its call`, async (t) => {
    const f = await concurrencyFixture(t, kind, { maxConcurrent: 2 });
    const bad = assert.rejects(
      f.runtime.callTool('probe', { id: 'bad', fail: true }),
      errorCode('HANDLER_FAILED'),
    );
    const good = f.runtime.callTool('probe', { id: 'good' });
    await Promise.all([f.started('bad'), f.started('good')]);
    await f.release('bad');
    await bad;
    assert.equal(f.runtime.health().workers.primary.activeCount, 1);
    await f.release('good');
    await good;
  });
}

test('python: synchronous and asynchronous handlers overlap in the same worker', async (t) => {
  const f = await concurrencyFixture(t, 'python', { maxConcurrent: 2 });
  const sync = f.runtime.callTool('sync', { id: 'sync' });
  await f.started('sync');
  const async = f.runtime.callTool('probe', { id: 'async' });
  await f.started('async');
  await f.release('async');
  assert.equal((await async).structuredContent.id, 'async');
  assert.equal(await f.read('finished-sync'), undefined);
  await f.release('sync');
  await sync;
});

test('python: saturated sync executor does not starve the command reader', async (t) => {
  const f = await concurrencyFixture(t, 'python', { maxConcurrent: 41 });
  // Python's default executor is capped at 32 threads. Keep more synchronous
  // calls blocked than it can run; the later async call must still be received.
  const ids = Array.from({ length: 40 }, (_, i) => `sync-${i}`);
  const syncCalls = ids.map((id) => f.runtime.callTool('sync', { id }));
  const asyncCall = f.runtime.callTool('probe', { id: 'async' });
  await f.started('async');
  await f.release('async');
  await asyncCall;
  assert.equal(await f.read('finished-sync-0'), undefined);
  await Promise.all(ids.map((id) => f.release(id)));
  await Promise.all(syncCalls);
});
