<p align="center">
  <img src="https://raw.githubusercontent.com/ModernSoftware/mcpack/main/docs/assets/banner.svg" alt="MCPack — Native MCP tools. Multiple runtimes. One manifest." width="100%" />
</p>

<p align="center">
  <a href="https://github.com/ModernSoftware/mcpack/actions/workflows/ci.yml"><img src="https://github.com/ModernSoftware/mcpack/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/Node.js-22%2B-43853d" alt="Node.js 22+" />
  <img src="https://img.shields.io/badge/Python-3.11%2B-3776ab" alt="Python 3.11+" />
  <a href="https://www.npmjs.com/package/@modern-software/mcpack"><img src="https://img.shields.io/npm/v/@modern-software/mcpack" alt="npm version" /></a>
</p>

<p align="center">
  <a href="#run-the-example">Quick start</a> ·
  <a href="docs/contracts.md">Contracts</a> ·
  <a href="docs/http.md">HTTP & authentication</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

# MCPack

**MCPack is a manifest-driven runtime for building and deploying MCP servers.**
Connect native tools, resources and prompts written in Node or Python to one server,
keep their workers alive between calls, and expose them over stdio or Streamable HTTP.
Its aim is to make multi-language MCP execution consistent from development to deployment,
with explicit lifecycle, concurrency and failure handling.

MCPack provides the native execution foundation for
[**Modern MCP Forge**](https://github.com/ModernSoftware/modern-mcp-forge), our visual MCP
development environment. Use it independently through the CLI or Node API, or develop
native projects through Forge's integration. The Forge prototype is verified; full
project-level integration remains on the roadmap.

[**npm package**](https://www.npmjs.com/package/@modern-software/mcpack) ·
[**Changelog**](CHANGELOG.md) · [**Benchmarks**](docs/performance.md)

## Write handlers. Keep your runtime. Serve MCP.

| Capability           | What you get                                                         |
| -------------------- | -------------------------------------------------------------------- |
| 🧩 One manifest      | Declare tools, resources, prompts, entrypoints, and worker settings. |
| 🟢 Node + 🐍 Python  | Keep language-specific dependencies and persistent factory state.    |
| 🔌 Two transports    | Start a stdio server or a standalone Streamable HTTP endpoint.       |
| ⏱️ Bounded execution | Queue limits, deadlines, cancellation, and bounded shutdown.         |
| 🛠️ Develop in Forge  | Test the same native manifest and code used by the standalone CLI.   |

![MCPack architecture: clients reach one Node host backed by persistent Node and Python workers](https://raw.githubusercontent.com/ModernSoftware/mcpack/main/docs/assets/architecture.svg)

**MCPack owns native execution and deployment.** Modern MCP Forge provides the development
UI. External MCP connections and language bridges belong to Forge's integration roadmap;
MCPack does not bundle or proxy them.

## Run the example

Requires Node.js 22 or newer and npm. From the repository root:

```sh
npm ci
npm test
node dist/cli.js validate examples/hello/mcpack.json
node dist/cli.js serve examples/hello/mcpack.json
```

`serve` defaults to an MCP client on stdin/stdout. Add `--transport http --port 3000` for a standalone Streamable HTTP endpoint at `http://127.0.0.1:3000/mcp`. Configure a client with `node` as its command and absolute paths to `dist/cli.js` and the manifest:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/mcpack/dist/cli.js",
    "serve",
    "/absolute/path/mcpack/examples/hello/mcpack.json"
  ]
}
```

The example provides `greet`, `mcpack://hello/guide`, and `welcome`. Repeated greetings return an increasing count and the same worker PID. A second persistent worker serves the resource and prompt.

## Author a native project

Keep a `mcpack.json` file alongside your handler code. A worker declares a runtime, source module, and factory. Tools, resources, and prompts bind to named handlers returned by that factory.

```json
{
  "schemaVersion": 1,
  "name": "my-server",
  "version": "1.0.0",
  "workers": {
    "main": { "runtime": "node", "module": "./handlers.mjs" }
  },
  "tools": [
    {
      "name": "greet",
      "worker": "main",
      "handler": "greet",
      "inputSchema": {
        "type": "object",
        "properties": { "name": { "type": "string" } },
        "required": ["name"],
        "additionalProperties": false
      }
    }
  ]
}
```

```js
// handlers.mjs
export async function createWorker(context) {
  // Open a database pool or initialize a client once here.
  let calls = 0;

  return {
    tools: {
      async greet({ name }, call) {
        call.signal.throwIfAborted();
        calls += 1;
        return {
          content: [{ type: 'text', text: `Hello, ${name}!` }],
          structuredContent: { calls },
        };
      },
    },
    async close() {
      // Close the pool/client here.
      context.log('Worker closed');
    },
  };
}
```

TypeScript projects compile handlers before execution and point `module` at the resulting JavaScript inside the project directory. There is no implicit TypeScript loader or build step. The exported `CreateWorker`, `NativeWorker`, `Handler`, and result types describe the authoring contract.

## Add Python to the same server

Python workers require Python 3.11 or newer; Node-only projects do not require Python.
The included runner uses only the Python standard library. Install your application’s
Python dependencies in its own environment, then select that environment’s interpreter:

```json
{
  "runtime": "python",
  "module": "./python_handlers.py",
  "executable": "./.venv/bin/python"
}
```

On Windows use `./.venv/Scripts/python.exe`. Paths are relative to the manifest;
absolute interpreter paths are also supported. Without `executable`, MCPack searches
PATH for `python3` on Unix or `python` on Windows. This is an executable path, not a shell
command; do not include arguments or quotes in its value.

```python
# python_handlers.py
def create_worker(context):
    def greet(args, call):
        call.signal.throw_if_aborted()
        return {"content": [{"type": "text", "text": f"Hello, {args['name']}!"}]}

    return {"tools": {"greet": greet}}
```

Factories, handlers, and cleanup hooks may be synchronous or async. The Python factory
returns a dictionary of handler maps with an optional `close` callable. Context uses
`worker_id`, `project_root`, `config`, `log`, and, for calls, `request_id` and `signal`.
See the [Python contract](docs/python.md) for lifecycle, imports, and result details.

After `npm run build`, try the mixed-language project:

```sh
node dist/cli.js validate examples/mixed/mcpack.json
node dist/cli.js serve examples/mixed/mcpack.json
```

It exposes Node’s `greet`, Python’s `summarize`, a Python resource, and a Python prompt
through one MCP server. Each worker remains alive across calls. The same manifest can
be loaded by Forge’s native integration after installing this MCPack revision locally.
The standalone CLI supports stdio and HTTP. Forge continues to own its separate Streamable HTTP endpoint and connects to MCPack over stdio.

## Embed the same runtime

After installing the npm package (or a local tarball while testing a release):

```ts
import { MCPackRuntime, createMcpServer } from '@modern-software/mcpack';

const runtime = await MCPackRuntime.load('/project/mcpack.json', {
  diagnostic: (worker, stream, text) => console.error(worker, stream, text),
});

try {
  await runtime.start();
  const result = await runtime.callTool('greet', { name: 'Diego' });
  console.log(result);
  // A host can also use createMcpServer(runtime) with an SDK transport.
} finally {
  await runtime.close();
}
```

Forge’s native prototype launches the MCPack CLI over stdio, using the same runtime and contracts. Other hosts can embed the API above directly. External MCP servers and language bridges remain Forge features; MCPack does not proxy or package them.

## Operating model

- One child process per named worker; one active call per process by default. Opt in with worker `maxConcurrent` to overlap I/O calls (see [concurrency contracts](docs/contracts.md#opt-in-concurrency)). Separate workers run concurrently. Each process has its own factory state.
- A bounded FIFO queue and deadline apply to every invocation. The deadline includes queue wait.
- Active cancellation, timeout, or process failure retires that worker. Other active and queued requests fail; other workers keep serving. There are no automatic operation retries. Opt-in [worker recovery](docs/recovery.md) restarts failed processes with bounded backoff; otherwise recreate the runtime to recover.
- Graceful shutdown invokes `close()` with a bounded wait, then kills processes that do not exit. Forced shutdown cannot guarantee application cleanup or rollback of external writes.
- Worker responses default to a 1 MiB serialized envelope limit. Diagnostic delivery defaults to 64 KiB per worker per one-second window; dropped-byte counters are available in runtime health. See [limit semantics](docs/contracts.md#output-limits-and-compatibility).
- Worker stdout/stderr are diagnostics, separated from MCP protocol stdout. Treat diagnostics as potentially sensitive application output.
- Environment inheritance is explicit, apart from basic OS executable/temp variables. Use `inheritEnv` for credentials provided by your deployment environment. Do not put secrets in the manifest's literal `env` object.

## Security and deployment boundaries

MCPack is designed for **trusted application code and controlled service access**.
It supplies execution and transport controls; your deployment supplies TLS,
identity policy, secret management and resource isolation.

| Included                                                              | Boundary                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Bearer service token or custom authorization callback                 | Endpoint admission; no built-in OAuth issuer, tenant propagation or per-tool permissions     |
| Host/Origin checks; authenticated non-loopback binding                | Terminate TLS at ingress and restrict direct backend access                                  |
| Strict manifest/input/result validation and project entrypoint checks | Schema `format` assertions are not validated; handlers remain responsible for business rules |
| Explicit worker environment forwarding                                | Use a secret manager/environment; never commit credentials in manifests                      |
| Bounded requests, queues, deadlines, outputs and diagnostics          | Admission limits are not distributed rate limiting or memory quotas                          |
| Process isolation and opt-in restart with backoff                     | Workers are not sandboxes; timeout/cancellation can fail sibling calls in that worker        |
| No automatic operation replay                                         | Applications own idempotency and reconciliation of uncertain external writes                 |

CI tests authentication failures, request limits, cancellation, crashes, recovery,
cleanup and installed-package operation. The Support Desk sample has also been
reported working on AWS through public ingress with Inspector and a Bedrock agent.
These checks do not constitute a penetration test, SLA or certification for every
production workload. See [security policy](SECURITY.md), [HTTP/authentication](docs/http.md)
and [deployment guidance](docs/deployment.md).

## Performance and capacity

The [benchmark guide and raw reports](docs/performance.md) distinguish synthetic
runtime overhead from application/network latency. A maintainer-reported Support
Desk run measured **100 requests at concurrency 4**, with **0 failures**, **202 ms
p50**, **452 ms p95**, **886 ms p99**, and **18.09 requests/second**. This roughly
5.5-second smoke run is not a maximum-capacity test; its exact endpoint, machine and
commit were not captured with the measurements.

| Control                                      |                                      Default | Configurable range / meaning                                                                             |
| -------------------------------------------- | -------------------------------------------: | -------------------------------------------------------------------------------------------------------- |
| Active calls per worker (`maxConcurrent`)    |                                            1 | 1–1,000; opt in only for handlers safe to overlap                                                        |
| Waiting calls per worker (`maxQueue`)        |                                           32 | 0–1,000; queue wait counts toward the invocation deadline                                                |
| Admitted HTTP exchanges (`maxInFlight`)      |                                          128 | 1–10,000 per host; includes auth/body reads, not a requests/sec target                                   |
| Invocation deadline                          |                                   30 seconds | 1–300,000 ms per worker                                                                                  |
| HTTP request body / worker response envelope |                                   1 MiB each | Separate configurable limits, up to 64 MiB each                                                          |
| Tools/resources/prompts                      | No explicit count cap in the manifest schema | Practical size depends on memory, discovery responses and client limits; no large-catalog capacity claim |

The Support Desk sample overrides these defaults: **3 workers**, **4 concurrent
calls per worker**, **16 queued calls per worker**, and **32 admitted HTTP
exchanges**, serving **9 tools, 2 resources and 2 prompts**. These are tested example
settings, not total connection or catalog limits. CPU work, DB connection pools,
upstream quotas and response sizes determine throughput. There is no measured
maximum TCP connection count or universal requests/sec guarantee. Load-test your
workload before sizing replicas; multiple replicas do not share in-memory state.

## Scope

Node and Python native tools/resources/prompts; static discovery; text/JSON results;
stdio and stateless Streamable HTTP; embedding API; bounded concurrency, queues,
deadlines and opt-in recovery. The HTTP host has no persistent MCP session store.

Not included: .NET/Go workers, built-in OAuth/user-context propagation, runtime
sandboxing, hard per-worker memory quotas, hot reload, resource templates/subscriptions,
binary media results, output schemas, tasks, sampling or elicitation.

Handler code is **trusted executable code**. Project-relative entrypoint checks do
not prevent imports, filesystem/network access, subprocess creation or external side
effects. Use deployment isolation. Killing a worker does not manage arbitrary
child processes it spawned or guarantee rollback of a database/API operation.

## Distribution

Find the package and registry README at
[**@modern-software/mcpack on npm**](https://www.npmjs.com/package/@modern-software/mcpack).
This checkout prepares **0.9.0**; that version becomes installable after the release
workflow stages it and the maintainer approves publication. The npm badge shows
registry state, which may lag this branch.

Once 0.9.0 is approved:

```sh
npm install --save-exact @modern-software/mcpack@0.9.0
npx mcpack validate ./mcpack.json
npx mcpack serve ./mcpack.json --transport http --port 3000
```

Use your own manifest and handler files (see above). Node and optional Python
interpreters/application dependencies are prerequisites, not bundled runtimes.
The package includes compiled JS/types, the Python runner, documentation and small
examples. The larger Support Desk lab is repository-only. Version 0.x permits API
evolution; pin versions and review the [changelog](CHANGELOG.md) before upgrades.

## Roadmap

The v0.9.0 scope is frozen around Node and Python. These are planned directions,
not release-date commitments; follow [issues](https://github.com/ModernSoftware/mcpack/issues)
and the [detailed roadmap](docs/roadmap.md).

| Project          | Next milestones                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| MCPack           | Approve v0.9.0 on npm; switch Support Desk to an exact registry pin while retaining source-built CI              |
| MCPack           | Record sustained-load, process-tree memory, restart and rolling-update evidence; prioritize reproducible defects |
| MCPack           | Add .NET, then Go runners using the existing lifecycle/error contracts and parity tests                          |
| MCPack           | Evaluate identity propagation and additional MCP capabilities against concrete consumer requirements             |
| Modern MCP Forge | Complete project-level native MCPack authoring, Monaco editing, diagnostics and deliberate reload                |
| Modern MCP Forge | Add external MCP sources and language bridges, with authentication configuration and collision-safe routing      |
| Modern MCP Forge | Combine sources in one development endpoint; export/deploy native MCPack projects independently                  |

Forge integration work lives in
[ModernSoftware/modern-mcp-forge](https://github.com/ModernSoftware/modern-mcp-forge).
External/bridged source aggregation belongs to Forge; MCPack deployment remains native-only.

## Contributing

Start with an [issue](https://github.com/ModernSoftware/mcpack/issues), then submit a focused
pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and the
[repository workflow](docs/repository-governance.md) for branch protection.

## License

Copyright 2026 Modern Software and MCPack contributors. Licensed under the
[Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).

See [contracts](docs/contracts.md), [architecture decisions](docs/architecture.md), and [implementation roadmap](docs/roadmap.md).

See [HTTP operation and authentication](docs/http.md), [performance measurements](docs/performance.md), and [npm release preparation](docs/releasing.md).

## Deployment candidate

See [worker recovery](docs/recovery.md) for opt-in restart policies and
[deployment guidance](docs/deployment.md) for the non-root Node/Python Docker
reference, service-identity security scope, probes, resource limits and AWS validation
gates. This increment does not publish an image or claim production certification.

## Realistic application sample

The [Support Desk PoC](examples/support-desk/README.md) combines Node and Python
workers with PostgreSQL, S3 documents, and a simulated refund API. Run it with
Docker Compose without AWS credentials, or use its Terraform runbook to test
the same application over public HTTPS on AWS.

### Build a real application

Read [One MCP server, two languages](docs/articles/mcpack-support-desk.md), our article
draft about the Support Desk experiment, its architecture, approval workflow and
benchmark evidence. The [sample](examples/support-desk/README.md) now installs
MCPack 0.9.0 from npm by default, with local Compose and an AWS deployment runbook.
