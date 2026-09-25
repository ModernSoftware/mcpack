import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { cpus, platform, release, tmpdir } from 'node:os';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, copyFile, writeFile, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MCPackRuntime, serveHttp } from '../dist/index.js';

const { values } = parseArgs({
  options: {
    iterations: { type: 'string', default: '100' },
    output: { type: 'string', default: '.benchmark/results.json' },
  },
});
const count = Number(values.iterations);
if (!Number.isInteger(count) || count < 1 || count > 10000)
  throw new Error('iterations must be 1–10000');
const exec = promisify(execFile);
const python = (
  await exec(process.platform === 'win32' ? 'python' : 'python3', ['--version'])
).stdout.trim();
const root = await mkdtemp(join(tmpdir(), 'mcpack-benchmark-'));
const sourceFiles = [
  ...(await readdir(new URL('../src/', import.meta.url)))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/${name}`),
  'runtimes/python/worker.py',
  'package-lock.json',
  'benchmark/run.mjs',
  'benchmark/handlers.mjs',
  'benchmark/handlers.py',
].sort();
const hash = createHash('sha256');
for (const file of sourceFiles) {
  hash.update(file + '\0');
  hash.update(await readFile(new URL(`../${file}`, import.meta.url)));
}
const report = {
  measuredAt: new Date().toISOString(),
  sourceSha256: hash.digest('hex'),
  sourceFiles,
  environment: {
    os: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    node: process.version,
    python,
  },
  iterationsPerCase: count,
  notes: [
    'Synthetic baseline, not a production capacity claim. Compare runs on the same machine.',
    'Warm latency includes host validation and queue time; HTTP also includes SDK/client/network work.',
    'Each language has one worker. Concurrency is callers, not replicas.',
    'RSS below covers the Node benchmark host only; it excludes worker and total deployment memory.',
  ],
  coldStartMs: {},
  results: [],
};
let runtime;
let host;
let client;

async function measure(call, transport, language, workload, args, concurrency) {
  for (let i = 0; i < 5; i++) await call(language, args);
  const latencies = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < count) {
        const begun = performance.now();
        const result = await call(language, args);
        if (result.isError) throw new Error('Unexpected business error during benchmark');
        latencies.push(performance.now() - begun);
      }
    }),
  );
  const elapsed = performance.now() - start;
  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)];
  report.results.push({
    transport,
    language,
    workload,
    concurrency,
    calls: count,
    elapsedMs: elapsed,
    throughputPerSecond: (count * 1000) / elapsed,
    latencyMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: latencies.at(-1),
    },
  });
}

try {
  for (const file of ['handlers.mjs', 'handlers.py'])
    await copyFile(new URL(file, import.meta.url), join(root, file));
  const manifest = {
    schemaVersion: 1,
    name: 'benchmark',
    version: '1',
    workers: {
      node: { runtime: 'node', module: './handlers.mjs', maxQueue: 16 },
      python: { runtime: 'python', module: './handlers.py', maxQueue: 16 },
    },
    tools: ['node', 'python'].map((worker) => ({
      name: worker,
      worker,
      handler: 'probe',
      inputSchema: { type: 'object' },
    })),
  };
  const filename = join(root, 'mcpack.json');
  await writeFile(filename, JSON.stringify(manifest));
  const cases = [
    ['noop', {}],
    ['payload-16KiB', { payload: 'x'.repeat(16384) }],
    ['io-5ms', { delayMs: 5 }],
    ['cpu-50000', { iterations: 50000 }],
  ];
  for (const transport of ['runtime', 'http']) {
    const begun = performance.now();
    let call;
    if (transport === 'runtime') {
      runtime = await MCPackRuntime.load(filename);
      await runtime.start();
      call = (name, args) => runtime.callTool(name, args);
    } else {
      host = await serveHttp(filename, { port: 0 });
      client = new Client(
        { name: 'benchmark', version: '1' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(host.url)));
      call = (name, args) => client.callTool({ name, arguments: args });
    }
    report.coldStartMs[transport] = performance.now() - begun;
    for (const language of ['node', 'python']) {
      for (const [workload, args] of cases) {
        for (const concurrency of [1, 8])
          await measure(call, transport, language, workload, args, concurrency);
      }
    }
    if (runtime) {
      await runtime.close();
      runtime = undefined;
    }
    if (client) {
      await client.close();
      client = undefined;
    }
    if (host) {
      await host.close();
      host = undefined;
    }
  }
  // Bounded-queue evidence, deliberately separate from successful-call latency.
  manifest.workers.node.maxQueue = 2;
  await writeFile(filename, JSON.stringify(manifest));
  runtime = await MCPackRuntime.load(filename);
  await runtime.start();
  const outcomes = await Promise.all(
    Array.from({ length: 12 }, () =>
      runtime.callTool('node', { delayMs: 50 }).then(
        () => 'success',
        (error) => error.code,
      ),
    ),
  );
  report.saturation = outcomes.reduce(
    (totals, code) => ({ ...totals, [code]: (totals[code] ?? 0) + 1 }),
    {},
  );
  if (report.saturation.success !== 3 || report.saturation.QUEUE_FULL !== 9)
    throw new Error('Queue admission behavior changed');
  report.hostRssBytes = process.memoryUsage().rss;
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Saved ${report.results.length} cases to ${output}`);
} finally {
  await client?.close();
  await host?.close();
  await runtime?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
