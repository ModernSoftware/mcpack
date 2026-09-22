# MCPack

MCPack runs native MCP tools, resources, and prompts from a versioned project manifest. It keeps handler processes alive between calls and exposes their capabilities through the official TypeScript MCP SDK.

This is the first **Node-only alpha**. It is a foundation for Modern MCP Forge's native runtime, not yet a production release. Forge integration is a subsequent change.

## Run the example

Requires Node.js 22 or newer and npm. From the repository root:

```sh
npm ci
npm test
node dist/cli.js validate examples/hello/mcpack.json
node dist/cli.js serve examples/hello/mcpack.json
```

`serve` waits for an MCP client on stdin/stdout; it does not start an HTTP listener. Configure a client with `node` as its command and absolute paths to `dist/cli.js` and the manifest:

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

Keep a `mcpack.json` file alongside your handler code. A worker declares a JavaScript module and an exported factory. Tools, resources, and prompts bind to named handlers returned by that factory.

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

## Embed the same runtime

Once the package is installed from a local tarball or workspace:

```ts
import { MCPackRuntime, createMcpServer } from '@modernsoftware/mcpack';

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

Forge will consume this API for **native** projects. External MCP servers and language bridges remain Forge features; MCPack does not proxy or package them.

## Operating model

- One child process per named worker; one active call per process. Separate workers run concurrently. Each process has its own factory state.
- A bounded FIFO queue and deadline apply to every invocation. The deadline includes queue wait.
- Active cancellation, timeout, or process failure retires that worker. Queued requests fail; other workers keep serving. There are no automatic retries or restarts. Recreate the runtime to recover a retired worker in this alpha.
- Graceful shutdown invokes `close()` with a bounded wait, then kills processes that do not exit. Forced shutdown cannot guarantee application cleanup or rollback of external writes.
- Worker stdout/stderr are diagnostics, separated from MCP protocol stdout. Treat diagnostics as potentially sensitive application output.
- Environment inheritance is explicit, apart from basic OS executable/temp variables. Use `inheritEnv` for credentials provided by your deployment environment. Do not put secrets in the manifest's literal `env` object.

## Scope and next steps

Implemented: manifest validation, Node factories, persistent named workers, bounded queues, cancellation/deadlines, graceful shutdown, text tool/resource/prompt results, static discovery, stdio serving, and an embedding API.

Not implemented: HTTP serving/authentication, Python/.NET workers, replicated worker pools, automatic recovery, hot reload, resource templates/subscriptions, binary or rich media results, output schemas, tasks, sampling, and elicitation. No latency or production-readiness claim is made yet.

Handler code is **trusted executable code**. A child process and a project-relative entrypoint are not a sandbox. Modules can import other files, access the network and filesystem, spawn children, and cause side effects. Use deployment isolation for untrusted code. Killing a worker does not manage arbitrary descendants it spawned.

The package is private and unlicensed pending the owner's distribution decision. `npm pack` creates a local installable package; registry publication is intentionally disabled.

See [contracts](docs/contracts.md), [architecture decisions](docs/architecture.md), and [implementation roadmap](docs/roadmap.md).
