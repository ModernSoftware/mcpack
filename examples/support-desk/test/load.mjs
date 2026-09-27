import { performance } from 'node:perf_hooks';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const count = Number(process.env.REQUESTS ?? 100);
const concurrency = Number(process.env.CONCURRENCY ?? 4);
if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 10000 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 32
)
  throw Error('REQUESTS must be 1..10000; CONCURRENCY 1..32');
const client = new Client({ name: 'support-desk-load', version: '1' });
const durations = [];
let next = 0,
  failures = 0;
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(process.env.MCP_URL ?? 'http://localhost:3000/mcp'), {
      requestInit: {
        headers: { authorization: `Bearer ${process.env.MCPACK_HTTP_TOKEN ?? 'local-mcp-only'}` },
      },
    }),
  );
  const start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < count) {
        const before = performance.now();
        try {
          const r = await client.callTool({
            name: 'get_order_details',
            arguments: { order_id: 'ORD-10482' },
          });
          if (r.isError) failures++;
        } catch {
          failures++;
        }
        durations.push(performance.now() - before);
      }
    }),
  );
  durations.sort((a, b) => a - b);
  const percentile = (p) =>
    Math.round(durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)]);
  console.log(
    JSON.stringify(
      {
        requests: count,
        concurrency,
        failures,
        p50_ms: percentile(0.5),
        p95_ms: percentile(0.95),
        p99_ms: percentile(0.99),
        requests_per_second: Number((count / ((performance.now() - start) / 1000)).toFixed(2)),
      },
      null,
      2,
    ),
  );
  if (failures) process.exitCode = 1;
} finally {
  await client.close();
}
