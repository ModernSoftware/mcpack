import test from 'node:test';
import assert from 'node:assert/strict';
import { MCPackRuntime } from '../dist/index.js';
import { assertToolInputLimits, resolveToolInputLimits } from '../dist/input-limits.js';

test('input budget includes every nested array slot and own object member', () => {
  const limits = resolveToolInputLimits({ maxToolInputElements: 4 });
  assertToolInputLimits({ items: [{ value: 1 }, 2] }, limits);
  assert.throws(() => assertToolInputLimits({ items: [{ value: 1 }, 2, 3] }, limits), {
    code: 'INVALID_ARGUMENTS',
  });
  assert.throws(() => assertToolInputLimits({ items: new Array(100_000) }, limits), {
    code: 'INVALID_ARGUMENTS',
  });
});

test('depth and cycles are rejected without recursive traversal or unbounded work', () => {
  const limits = resolveToolInputLimits({ maxToolInputDepth: 2 });
  assertToolInputLimits({ a: { b: 1 } }, limits);
  assert.throws(() => assertToolInputLimits({ a: { b: {} } }, limits), /nesting depth/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => assertToolInputLimits(cyclic, limits), /nesting depth/);
  for (const value of [0, -1, Infinity, NaN, 1.5]) {
    assert.throws(() => resolveToolInputLimits({ maxToolInputElements: value }), RangeError);
    assert.throws(() => resolveToolInputLimits({ maxToolInputDepth: value }), RangeError);
  }
});

test('embedded runtime rejects over-budget input before schema validation or worker dispatch', async (t) => {
  const runtime = await MCPackRuntime.load('examples/mixed/mcpack.json', {
    maxToolInputElements: 4,
  });
  t.after(() => runtime.close());
  await runtime.start();
  await assert.rejects(runtime.callTool('summarize', { values: [1, 2, 3, 4] }), {
    code: 'INVALID_ARGUMENTS',
    message: 'Tool arguments exceed the element limit',
  });
  assert.equal(
    (await runtime.callTool('summarize', { values: [1, 2, 3] })).structuredContent.total,
    6,
  );
});
