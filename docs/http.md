# Standalone Streamable HTTP

```sh
node dist/cli.js serve examples/mixed/mcpack.json --transport http --port 3000
```

Connect an MCP client to `http://127.0.0.1:3000/mcp`. Stdio remains the default, so
existing Forge installations and client commands continue to work unchanged.

## Lifecycle and sessions

The host starts all declared workers before listening. A fresh official SDK server
handles each HTTP request over the same persistent native runtime. Both modern
negotiated requests and legacy stateless Streamable HTTP are supported. No MCP session
ID, session store, resumable stream, subscription, or per-client worker is created.
Legacy GET/DELETE session operations return 405. Worker state is shared across clients;
do not use it as implicit per-user storage.

Disconnecting a client does not close the shared runtime. Aborting an active HTTP
request propagates to its native call and retires that worker; queued cancellation
removes only the queued call. The host combines the HTTP request signal with the SDK
call signal for tools, resources, and prompts. A legacy cancellation notification sent
as a separate request cannot locate a call in another stateless request: the client
must abort the original HTTP exchange, or the configured deadline will bound execution.
Cancellation never proves an external write was rolled back; no automatic retry occurs.

SIGINT/SIGTERM trigger CLI shutdown on platforms that deliver those signals. The host
stops accepting new connections, grants in-flight requests a grace period, then aborts
remaining exchanges, closes workers using their individual shutdown limits, and closes
HTTP sockets. Calling the embedding handle’s `close()` is idempotent. Forced OS process
termination cannot promise cleanup, particularly on Windows or for application-spawned
child processes.

## Access control

The default bind address is `127.0.0.1`. Local unauthenticated mode is for development.
For a service token, set an environment variable and name it on the command line:

```sh
# Set MCPACK_HTTP_TOKEN in your process environment or secret manager first.
node dist/cli.js serve /project/mcpack.json --transport http --token-env MCPACK_HTTP_TOKEN
```

Send `Authorization: Bearer <token>` on every MCP request. Token values are not CLI
arguments and are not implicitly forwarded to native workers. This is a service-token
gate, not an OAuth authorization server or user identity contract.

Non-loopback binding requires both authentication and an explicit Host allowlist:

```sh
node dist/cli.js serve /project/mcpack.json --transport http --host 0.0.0.0 \
  --allow-host mcp.example.com --token-env MCPACK_HTTP_TOKEN
```

Terminate TLS at a reverse proxy and forward the configured Host. The server does not
trust `Forwarded` or `X-Forwarded-*` headers. `--allow-host` takes hostnames without ports;
it can be repeated. Origin, when present, must match the request origin or an exact
`--allow-origin https://app.example.com` entry. An origin allowlist does not enable CORS:
browser cross-origin credentials/preflight policies remain a reverse-proxy concern.

Embedding hosts can use their own asynchronous authentication/authorization logic:

```ts
import { serveHttp } from '@modernsoftware/mcpack';

const host = await serveHttp('/project/mcpack.json', {
  host: '127.0.0.1',
  port: 3000,
  authorize: async ({ headers, signal }) => {
    // Verify credentials with your identity service; fail closed on errors.
    return verifyAccess(headers.get('authorization'), signal);
  },
});
// During application shutdown:
await host.close();
```

`authorize` receives method, URL, Headers, and an AbortSignal before the body is read.
Return false to deny (401); exceptions produce a generic 500. The callback is bounded
by the HTTP deadline. It controls admission to the MCP endpoint; it does not inject
identity into native handlers or implement per-tool authorization. Those need a future
explicit request-context contract. Existing authenticated applications can still mount
`createMcpServer(runtime)` behind their own SDK transport and middleware.

## Limits and health

| CLI option             | Default | Meaning                                                                   |
| ---------------------- | ------: | ------------------------------------------------------------------------- |
| `--max-body-bytes`     | 1048576 | Maximum POST body, checked for both length-declared and streamed requests |
| `--max-in-flight`      |     128 | Concurrent admitted MCP exchanges, including authentication/body reads    |
| `--request-timeout-ms` |   60000 | Entire HTTP exchange, including authentication, upload and response       |
| `--shutdown-grace-ms`  |    5000 | Drain period before aborting remaining HTTP exchanges                     |

Native `timeoutMs` and `maxQueue` still apply inside each worker. HTTP request deadlines
are independent: whichever deadline expires first wins. Excess HTTP admission returns
503; oversized bodies return 413. Compressed request bodies are not accepted. Headers
are limited to 16 KiB. These are process-level limits, not distributed rate limiting.
There is no worker-output byte quota or worker memory quota in this alpha.

`GET /healthz` reports that the HTTP process is responding; `GET /readyz` returns 200
only while every worker is ready, otherwise 503. A failed worker makes readiness fail,
while unaffected workers can still execute. Probe responses contain only a status and
require Host/Origin validation but no bearer token. Detailed state is available to an
embedding host through `host.runtime.health()` (worker state, active flag, queue length).
A retired worker is not restarted automatically; restart the deployment deliberately.
