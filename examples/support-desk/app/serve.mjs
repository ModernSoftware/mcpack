import { fileURLToPath } from 'node:url';

const { serveHttp, bearerToken } = await import(
  process.env.MCPACK_ENTRY ?? '/opt/mcpack/dist/index.js'
);

const token = process.env.MCPACK_HTTP_TOKEN;

if (!token) throw Error('MCPACK_HTTP_TOKEN is required');

const hosts = new Set([
  '127.0.0.1',
  'localhost',
  ...(process.env.MCP_HOSTNAME ? [process.env.MCP_HOSTNAME] : []),
]);

// ALB health checks send the target's private IP as Host. Read only the trusted ECS
// metadata endpoint supplied by the platform; do not disable Host validation.
if (process.env.ECS_CONTAINER_METADATA_URI_V4) {
  const metadata = await fetch(process.env.ECS_CONTAINER_METADATA_URI_V4, {
    signal: AbortSignal.timeout(5000),
  }).then((r) => {
    if (!r.ok) throw Error('ECS metadata unavailable');

    return r.json();
  });

  for (const network of metadata.Networks ?? [])
    for (const ip of network.IPv4Addresses ?? []) hosts.add(ip);
}

const host = await serveHttp(fileURLToPath(new URL('./mcpack.json', import.meta.url)), {
  host: '0.0.0.0',
  port: 3000,
  allowedHosts: [...hosts],
  allowedOrigins: process.env.MCP_HOSTNAME ? [`https://${process.env.MCP_HOSTNAME}`] : [],
  authorize: bearerToken(token),
  maxInFlight: 32,
  requestTimeoutMs: 20000,
  shutdownGraceMs: 5000,
  diagnostic: (id, stream, text) => process.stderr.write(`[${id}:${stream}] ${text}`),
});

console.log('Support Desk MCP listening on port 3000');

let stopping;

for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    void (stopping ??= host.close()).catch(() => {
      process.exitCode = 1;
    });
  });
