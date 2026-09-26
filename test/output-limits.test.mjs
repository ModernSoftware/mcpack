import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MCPackRuntime, loadProject } from '../dist/index.js';
import { WorkerFrameReader } from '../dist/worker-framing.js';
import { DiagnosticLimiter } from '../dist/output-limits.js';

const nodeSource = `
export function createWorker() {
  return {
    tools: { async echo(input) {
      if (input.raw) {
        process.send({v: 1, type: 'result', id: 'bypass', result: 'x'.repeat(2048)});
        await new Promise(() => {});
      }
      if (input.log) process.stderr.write('é'.repeat(10000));
      return { content: [{type: 'text', text: (input.char ?? 'x').repeat(input.size ?? 0)}] };
    } },
    resources: { large() { return { contents: [{uri: 'test://large', text: 'x'.repeat(2048)}] }; } },
    prompts: { large() { return { messages: [{role: 'user', content: {type: 'text', text: 'x'.repeat(2048)}}] }; } }
  };
}`;
const pythonSource = `
import asyncio
import sys

def create_worker(context):
    async def echo(args, call):
        if args.get('raw'):
            sys.__stdout__.buffer.write(b'x' * 2048)
            sys.__stdout__.buffer.flush()
            await asyncio.Future()
        if args.get('log'):
            sys.stderr.write('é' * 10000)
            sys.stderr.flush()
        return {'content': [{'type': 'text', 'text': args.get('char', 'x') * args.get('size', 0)}]}
    def resource(args, call):
        return {'contents': [{'uri': 'test://large', 'text': 'x' * 2048}]}
    def prompt(args, call):
        return {'messages': [{'role': 'user', 'content': {'type': 'text', 'text': 'x' * 2048}}]}
    return {'tools': {'echo': echo}, 'resources': {'large': resource}, 'prompts': {'large': prompt}}
`;

async function fixture(t, runtime, options = {}, diagnostic) {
  const root = await mkdtemp(join(tmpdir(), 'mcpack-output-'));
  let host;
  t.after(async () => {
    await host?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const module = runtime === 'node' ? 'handlers.mjs' : 'handlers.py';
  await writeFile(join(root, module), runtime === 'node' ? nodeSource : pythonSource);
  const definition = { runtime, module: `./${module}`, maxOutputBytes: 1024, ...options };
  const manifest = {
    schemaVersion: 1,
    name: 'limits',
    version: '1',
    workers: { main: definition, other: definition },
    tools: ['main', 'other'].map((worker) => ({
      name: worker,
      worker,
      handler: 'echo',
      inputSchema: { type: 'object' },
    })),
    resources: [{ name: 'large', uri: 'test://large', worker: 'main', handler: 'large' }],
    prompts: [{ name: 'large', worker: 'main', handler: 'large' }],
  };
  const path = join(root, 'mcpack.json');
  await writeFile(path, JSON.stringify(manifest));
  host = await MCPackRuntime.load(path, { diagnostic });
  return { host, path, manifest };
}
const outputError = (error) => error.code === 'OUTPUT_LIMIT_EXCEEDED';
const frameOverhead = Buffer.byteLength(
  JSON.stringify({
    v: 1,
    type: 'result',
    id: '0'.repeat(36),
    result: { content: [{ type: 'text', text: '' }] },
  }),
);

for (const runtime of ['node', 'python']) {
  test(`${runtime}: output limit is a structured MCP infrastructure error`, async (t) => {
    const { path } = await fixture(t, runtime);
    const client = new Client({ name: 'limits-client', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'serve', path],
      stderr: 'pipe',
    });
    transport.stderr?.resume();
    try {
      await client.connect(transport);
      await assert.rejects(
        client.callTool({ name: 'main', arguments: { size: 2048 } }),
        (error) => error.code === -32603 && error.data?.mcpackCode === 'OUTPUT_LIMIT_EXCEEDED',
      );
      assert.equal(
        (await client.callTool({ name: 'main', arguments: { size: 1 } })).content[0].text,
        'x',
      );
    } finally {
      await client.close();
    }
  });

  test(`${runtime}: output byte boundary, Unicode, queue continuation and all capability kinds`, async (t) => {
    const { host } = await fixture(t, runtime);
    await host.start();
    const size = 1024 - frameOverhead;
    assert.equal((await host.callTool('main', { size })).content[0].text.length, size);
    const tooLarge = assert.rejects(host.callTool('main', { size: size + 1 }), outputError);
    const queued = host.callTool('main', { size: 1 });
    await tooLarge;
    assert.equal((await queued).content[0].text, 'x');
    await assert.rejects(
      host.callTool('main', { size: Math.floor(size / 2) + 1, char: 'é' }),
      outputError,
    );
    await assert.rejects(host.readResource('test://large'), outputError);
    await assert.rejects(host.getPrompt('large'), outputError);
    assert.equal(host.health().workers.main.state, 'ready');
    assert.equal((await host.callTool('main', {})).content[0].text, '');
    assert.equal(
      (await host.callTool('main', { size: 1, char: '\ud800' })).content[0].text,
      '\ud800',
    );
  });

  test(`${runtime}: bypassed output limit retires only offending worker and settles queued work`, async (t) => {
    const { host } = await fixture(t, runtime);
    await host.start();
    const active = assert.rejects(host.callTool('main', { raw: true }), outputError);
    const queued = assert.rejects(host.callTool('main', {}), outputError);
    await Promise.all([active, queued]);
    assert.equal(host.health().workers.main.state, 'failed');
    assert.equal((await host.callTool('other', { size: 1 })).content[0].text, 'x');
  });

  test(
    `${runtime}: diagnostics are bounded without killing a healthy worker`,
    { timeout: 15000 },
    async (t) => {
      let bytes = 0;
      const chunks = [];
      let seen;
      const received = new Promise((resolve) => {
        seen = resolve;
      });
      const { host } = await fixture(
        t,
        runtime,
        { maxDiagnosticBytesPerSecond: 1024 },
        (_worker, _stream, text) => {
          bytes += Buffer.byteLength(text);
          chunks.push(text);
          seen();
        },
      );
      await host.start();
      await host.callTool('main', { log: true });
      await received;
      // Pipe streams can drain after the response; closing waits for the process exit.
      await host.close();
      assert.ok(bytes > 0);
      assert.equal(host.health().workers.main.diagnostics.forwardedBytes, bytes);
      assert.ok(chunks.every((text) => Buffer.byteLength(text) <= 8192));
      assert.ok(host.health().workers.main.diagnostics.droppedBytes > 0);
    },
  );

  test(`${runtime}: manifest rejects invalid output and diagnostic budgets`, async (t) => {
    const { path, manifest } = await fixture(t, runtime);
    for (const [field, value] of [
      ['maxOutputBytes', 1023],
      ['maxOutputBytes', 64 * 1024 * 1024 + 1],
      ['maxOutputBytes', 1024.5],
      ['maxDiagnosticBytesPerSecond', -1],
      ['maxDiagnosticBytesPerSecond', 1024 * 1024 + 1],
    ]) {
      manifest.workers.main[field] = value;
      await writeFile(path, JSON.stringify(manifest));
      await assert.rejects(loadProject(path), (e) => e.code === 'INVALID_MANIFEST');
      delete manifest.workers.main[field];
    }
  });
}

test('frame reader bounds partial lines, counts UTF-8 bytes and releases a broken stream', () => {
  const received = [],
    errors = [];
  const reader = new WorkerFrameReader(
    8,
    (v) => received.push(v),
    (e) => errors.push(e.code),
  );
  reader.write(Buffer.from('"é"\n1\n'));
  assert.deepEqual(received, ['é', 1]);
  reader.write(Buffer.from('12345678'));
  assert.deepEqual(errors, []);
  reader.write(Buffer.from('9'));
  reader.write(Buffer.from('\n2\n'));
  assert.deepEqual(errors, ['OUTPUT_LIMIT_EXCEEDED']);
  assert.deepEqual(received, ['é', 1]);
});

test('frame reader accepts exact boundary, split UTF-8 and rejects malformed/incomplete frames', () => {
  const values = [],
    errors = [];
  const reader = new WorkerFrameReader(
    4,
    (v) => values.push(v),
    (e) => errors.push(e.code),
  );
  const bytes = Buffer.from('"é"\n');
  reader.write(bytes.subarray(0, 2));
  reader.write(bytes.subarray(2));
  assert.deepEqual(values, ['é']);
  for (const input of [Buffer.from('x\n'), Buffer.from([0xff, 10]), Buffer.from('12')]) {
    const broken = new WorkerFrameReader(
      4,
      () => assert.fail('invalid frame accepted'),
      (e) => errors.push(e.code),
    );
    broken.write(input);
    broken.end();
  }
  assert.deepEqual(errors, Array(3).fill('WORKER_PROTOCOL_ERROR'));
});

test('diagnostic quota shares streams, refills on time, preserves Unicode and bounds chunks', () => {
  let now = 0;
  const chunks = [];
  const limiter = new DiagnosticLimiter(
    10001,
    (_stream, text) => chunks.push(text),
    () => now,
  );
  limiter.write('stdout', 'é'.repeat(6000));
  limiter.write('stderr', 'abcd');
  assert.ok(chunks.every((text) => Buffer.byteLength(text) <= 8192 && !text.includes('\uFFFD')));
  assert.equal(limiter.snapshot().forwardedBytes, 10001);
  assert.equal(limiter.snapshot().droppedBytes, 2003);
  now = 1000;
  limiter.write('stderr', 'abc');
  assert.equal(limiter.snapshot().forwardedBytes, 10004);
  const muted = new DiagnosticLimiter(0, () => assert.fail('muted diagnostic delivered'));
  muted.write('stderr', 'hello');
  assert.equal(muted.snapshot().droppedBytes, 5);
});
