# Native contracts v1

The public manifest uses `schemaVersion: 1`. The private worker protocol independently uses `v: 1`. The TypeScript package remains an alpha; incompatible changes must be documented before consumers migrate. MCP wire negotiation belongs to the official SDK, not these version numbers.

## Manifest

`ManifestSchema` in `src/manifest.ts` is the executable definition. Unknown manifest fields are rejected. `loadProject(path)` validates without importing handler modules; startup separately verifies factory exports and handlers.

| Field             | Contract                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `schemaVersion`   | Exactly `1`                                                                                    |
| `name`, `version` | Server identity; name uses letters, digits, underscore or hyphen, 1–64 characters              |
| `workers`         | Nonempty map of worker identifiers to definitions                                              |
| `tools`           | Optional list; each has name, worker, handler, object inputSchema, optional description        |
| `resources`       | Optional list; each has name, absolute URI, worker, handler; optional description and mimeType |
| `prompts`         | Optional list; each has name, worker, handler, optional description and arguments              |

Names are unique within each capability category. Resource URIs and argument names within a prompt are unique. Cross-category equal names are permitted because their MCP operations differ. Every binding must reference an existing worker. Unbound handler functions are not published.

| Worker field                  | Default and meaning                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `runtime`                     | Required; `node` or `python`                                                                           |
| `module`                      | Required project-relative entrypoint; symlinks resolved and entrypoint must remain inside project root |
| `export`                      | `createWorker` for Node; `create_worker` for Python                                                    |
| `config`                      | `{}`; JSON configuration passed to the factory                                                         |
| `inheritEnv`                  | `[]`; parent variable names explicitly forwarded                                                       |
| `env`                         | `{}`; literal values override inherited environment                                                    |
| `startupTimeoutMs`            | `10000`; 1–300000                                                                                      |
| `timeoutMs`                   | `30000`; 1–300000, includes queue wait                                                                 |
| `shutdownTimeoutMs`           | `3000`; 1–30000                                                                                        |
| `maxOutputBytes`              | `1048576`; 1024–67108864 bytes per serialized worker response envelope                                 |
| `maxDiagnosticBytesPerSecond` | `65536`; 0–1048576 UTF-8 bytes forwarded per worker per fixed one-second window; 0 mutes diagnostics   |
| `maxQueue`                    | `32`; 0–1000 waiting requests, excluding active calls                                                  |

`maxConcurrent` defaults to `1` and accepts integers from 1 to 1000. It bounds active
calls across all tools, resources and prompts assigned to a worker. `maxQueue: 0`
still permits calls while execution slots are free; it disables waiting.

A worker runs with project root as cwd. Node uses the host’s Node executable without inherited CLI flags. Python uses the optional `executable` field (Python workers only), defaulting to `python` on Windows and `python3` elsewhere. An executable containing a path separator is resolved relative to the project; a bare name is resolved through PATH. It is never evaluated by a shell. Basic PATH/Path, SystemRoot/SYSTEMROOT, WINDIR, TEMP and TMP values are forwarded when present. Other values require opt-in. MCPack does not load `.env` files or expand `${VARIABLE}` strings. Factory code may use its own configuration library.

Tool input schemas are compiled with strict Ajv JSON Schema 2020-12 validation. Root type must be object. Schema formats are not validated in this alpha. Inputs are not coerced, defaults are not injected, and additional fields are rejected only when the schema says so. Remote schema fetching is not enabled. Bound JSON serializable inputs cross IPC; callers must not mutate arguments after dispatch.

## Factory and handlers

```ts
type CreateWorker = (context: WorkerContext) => NativeWorker | Promise<NativeWorker>;
```

`WorkerContext` exposes workerId, projectRoot, JSON config, and `log(message)`. The factory executes once for each named process and returns optional `tools`, `resources`, and `prompts` maps plus an optional `close()` hook. Startup checks all published handlers before marking the worker ready.

`CallContext` adds requestId and an AbortSignal. Inputs are:

| Handler  | Input                                      | Result                                                                                |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Tool     | JSON object, validated against inputSchema | `{ content: TextContent[], structuredContent?: JsonObject, isError?: boolean }`       |
| Resource | `{ uri: string }`                          | `{ contents: [{ uri, text, mimeType? }] }`                                            |
| Prompt   | String argument map                        | `{ messages: [{ role: 'user' \| 'assistant', content: TextContent }], description? }` |

`TextContent` is `{ type: 'text', text: string }`. The host validates all outputs. Node additionally validates capability shapes inside its worker; Python validates JSON representability inside its runner. Both expose the same INVALID_RESULT behavior and keep the worker usable after invalid output. This alpha intentionally accepts a text-only MCP subset. A resource handler can only return entries for its requested static URI. Prompt arguments must be declared; required arguments must exist and all values must be strings.

Native handler context does not expose HTTP headers, authenticated identity, client roots, sampling or elicitation. The standalone HTTP admission hook verifies access before calling the SDK but does not populate handler identity. Handlers must not assume such information is present or that transport authorization has occurred.

## Lifecycle and scheduling

1. Load and validate the manifest and schemas without executing handlers.
2. Start all declared workers; import modules, run factories, and verify bindings.
3. Expose the runtime after every worker reports ready. Any startup failure closes all workers.
4. Route each request to its named worker. Each worker executes sequentially by default; opt-in `maxConcurrent` allows overlapping calls. Different workers are independent.
5. Close the runtime to reject pending callers and request worker cleanup. Wait for exit, then force termination at the shutdown deadline.

`start()` and `close()` are idempotent at the runtime level. A closed runtime cannot restart. Calls before successful start are rejected. A worker cannot be restarted individually in this alpha.

Queued cancellation removes only that request. Active cancellation/deadline sends an abort notification and retires the process; signal delivery and cleanup are best effort before termination. The active caller gets its original cancellation/deadline error; all other active and queued callers get WORKER_UNAVAILABLE. With concurrency enabled, collateral active calls may already have produced external side effects. The system never retries an operation automatically. A cancelled or timed-out database write may already have committed; applications own idempotency and reconciliation.

Factory-owned state is shared by calls assigned to that worker, including different MCP clients if a future host shares the runtime. It is not per-user or durable storage.

## Error model

`MCPackError` exposes a stable `code` and a message. Handler exception details go to diagnostics, not public responses.

| Code                  | Meaning                                               |
| --------------------- | ----------------------------------------------------- |
| INVALID_MANIFEST      | Invalid manifest, schema, binding, or entrypoint path |
| INVALID_ARGUMENTS     | Tool schema or prompt argument validation failed      |
| NOT_FOUND             | Capability does not exist                             |
| OUTPUT_LIMIT_EXCEEDED | Worker response or raw frame exceeded its byte budget |
| INVALID_RESULT        | Handler output violates the native result contract    |
| HANDLER_FAILED        | Handler threw; worker can continue serving            |
| STARTUP_FAILED        | Factory/binding initialization failed or timed out    |
| WORKER_UNAVAILABLE    | Worker not ready or retired                           |
| WORKER_EXITED         | Child exited or disconnected unexpectedly             |
| WORKER_PROTOCOL_ERROR | Malformed, unexpected or unsendable IPC message       |
| QUEUE_FULL            | Worker admission limit reached                        |
| DEADLINE_EXCEEDED     | Invocation exceeded its deadline                      |
| CANCELLED             | Caller aborted                                        |
| RUNTIME_CLOSED        | Host shut down                                        |

At the MCP boundary, INVALID_ARGUMENTS and NOT_FOUND map to JSON-RPC `-32602`; other runtime errors map to `-32603`. The data object carries `mcpackCode`. Expected domain failures are returned by a tool as `isError: true`, not thrown. Output validation errors do not retire the worker; process/protocol failures do.

## Internal worker messages

Node uses a dedicated fork IPC channel with JSON serialization. It never multiplexes protocol frames with stdout. The host sends init, call, cancel and close; the child sends ready, result, error and closed. Calls and responses carry a host-generated ID. Unexpected IDs or invalid messages retire the worker.

Python uses UTF-8 newline-delimited JSON over its private stdin/stdout pipes with the same message envelope. The runner redirects Python `print()` to stderr before importing handlers. Low-level writes to fd 1 are forbidden and can retire the worker as a protocol failure. This private transport is not promised to external frameworks. Workers do not implement MCP themselves. Worker-to-host output is bounded as described below. There is no worker memory quota or general host-to-worker message-byte limit. The queue is bounded by count, so deployments must constrain input sizes and memory independently before exposing untrusted traffic.

Python factory conventions, interpreter selection, and result restrictions are documented in [Python native workers](python.md).

`MCPackRuntime.health()` returns runtime state, aggregate readiness, and each worker’s state, boolean active flag, numeric activeCount, and queued count, plus `diagnostics.forwardedBytes` and `diagnostics.droppedBytes` cumulative counters. The HTTP host uses it for readiness. `createMcpServer(runtime, { signal })` optionally combines a transport request signal with SDK call cancellation; existing single-argument callers remain supported.

## Output limits and compatibility

`maxOutputBytes` measures UTF-8 bytes of the compact JSON worker response envelope,
including version, response type, request ID and result. It excludes the Python line
terminator and Node IPC framing. JSON escaping counts; character count is not byte count.
The exact limit is accepted. This is a private-transport budget, not an MCP HTTP response
size guarantee: SDK wrapping and discovery responses have separate overhead.

The bundled Node/Python runners replace an oversized response with a small
`OUTPUT_LIMIT_EXCEEDED` error. The active request fails, queued work continues and the
worker remains usable. This never retries a handler or rolls back completed side effects.
If code bypasses the runner and emits an oversized raw frame, the host retires that
worker and rejects its active/queued requests with the same code. Other workers remain
available. Existing MCP mapping is retained: JSON-RPC -32603 with `data.mcpackCode`.

Python partial frames are counted as bytes and bounded before decoding/JSON parsing,
even without a newline. Invalid UTF-8 and unfinished frames are protocol errors.
Node's bundled runner checks before `process.send`; the host checks again after Node
has deserialized IPC. Direct application use of `process.send` can therefore allocate
memory before the host rejects it. Handler results and JSON serialization also allocate
memory inside a worker before size checking. These limits are not a sandbox, process
memory limit, or defense against arbitrary hostile code. Use container/process limits
and bounded DB/S3 queries in deployments.

Diagnostics use a shared budget for stdout/stderr per worker. The window starts at
worker launch and resets when output arrives at least one second after its previous
start (not a sliding window; boundary bursts can span two budgets). Excess bytes are
discarded while pipes keep draining; no backlog is retained for later delivery. Each
callback contains at most 8192 UTF-8 bytes. Truncated output may omit partial characters;
callbacks do not introduce half-characters. Counters measure UTF-8 bytes after stream
text decoding and remain available in health snapshots. Consumer exceptions are ignored;
forwarded bytes count delivery attempts. Consumers own any buffering/storage they add,
and slow synchronous callbacks can still block the host event loop.

Manifest schema version and handler signatures remain v1. Existing manifests gain finite
defaults: workloads returning more than 1 MiB or emitting more than 64 KiB of diagnostics
per window must configure budgets or reduce/paginate their output. Older package versions
reject the new fields; pin and upgrade MCPack before adding them. Treat unknown future
infrastructure error codes as failures rather than assuming an exhaustive fixed list.
Do not depend on private worker transport layouts across package versions.

## Opt-in concurrency

Set `maxConcurrent` on a worker, for example `"maxConcurrent": 4`, to overlap I/O
operations. Existing manifests retain sequential execution. Waiting calls are
admitted in FIFO order; completion order is not guaranteed. Deadlines still include
queue wait. Health retains `active: boolean` and adds `activeCount: number`.

The factory is initialized once. Every call shares its objects and connections;
handler authors must ensure these are safe for concurrent use. Python async handlers
share an event loop and synchronous handlers use the default thread executor. A
separate reader thread keeps protocol input independent of that executor. Executor
capacity may be lower than `maxConcurrent`; activeCount counts dispatched calls,
including calls awaiting a thread. Blocking Node handlers still block their worker's
event loop. This setting does not create processes or guarantee CPU parallelism.

A normal handler error or invalid/oversized response fails only that call. An active
cancellation/deadline, crash, or protocol violation retires the whole worker and fails
its other active and queued calls. Cancellation delivery is best effort; no operation
is automatically retried and external effects are not rolled back. Separate named
workers provide process-level fault isolation. Shutdown stops admission, signals and
waits for the active calls, then invokes factory cleanup; the existing shutdown bound
still forces termination if calls or cleanup do not finish.

Choose concurrency based on DB connection pools, downstream rate limits and memory.
The output limit remains per response, not an aggregate memory quota. Upgrade MCPack
before adding the new manifest field: older versions reject unknown fields.
