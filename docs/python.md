# Python native workers

MCPack remains a Node host. A `runtime: "python"` worker is a persistent Python 3.11+
process, not Python interpreted by Node and not an external MCP server. The bundled
runner requires no pip packages. Your application owns its Python dependencies.

## Interpreter and module

`module` is a project-relative `.py` entrypoint, subject to the same realpath boundary
check as Node modules. `export` defaults to `create_worker`. `executable` is optional:
its default is `python` on Windows and `python3` elsewhere. Bare names use PATH;
paths containing a separator resolve relative to the manifest directory, unless absolute.
Use `.venv/Scripts/python.exe` on Windows or `.venv/bin/python` on Unix for a virtual
environment. No shell, activation command, implicit pip install, or `.env` loading occurs.
An unavailable interpreter fails startup and closes the other workers.

The runner imports the entrypoint once under a private module name, with its containing
directory and the project root available for imports. Use absolute imports for local
packages or install your package into the chosen environment. Relative imports such as
`from .helpers import ...` inside the entrypoint are not supported. Imported code remains
trusted and can access files outside the project; entrypoint validation is not a sandbox.

## Factory and handlers

```python
def create_worker(context):
    calls = 0

    async def greet(args, call):
        nonlocal calls
        call.signal.throw_if_aborted()
        calls += 1
        return {
            "content": [{"type": "text", "text": f"Hello, {args['name']}!"}],
            "structuredContent": {"calls": calls},
        }

    def close():
        context.log("Released application resources")

    return {"tools": {"greet": greet}, "close": close}
```

The factory returns a dictionary. Optional `tools`, `resources`, and `prompts` entries
are dictionaries mapping handler names to callables. Optional `close` is a callable
with no arguments. Startup verifies every manifest binding before serving requests.
Factories, handlers and cleanup hooks can be synchronous or async.

Context attributes are `worker_id`, `project_root`, `config` (a dictionary), and `log`.
Call context adds `request_id` and `signal`; the latter exposes `aborted` and
`throw_if_aborted()`. It is a cooperative cancellation notification, not a Python task
cancellation guarantee. Active cancellation retires the entire worker, as with Node.

Inputs and result keys follow the [native contracts](contracts.md), including MCP's
camelCase keys such as `structuredContent`, `isError`, and `mimeType`. Return plain JSON
values: dictionaries with string keys, lists, strings, booleans, finite numbers, and
`None`. Sets, tuples, custom objects, non-string keys, NaN, and infinity are invalid.
Represent integers outside JavaScript’s safe integer range as strings to avoid precision
loss across the Node boundary; the Python runner rejects such integer outputs.

Handler exceptions produce HANDLER_FAILED with details restricted to diagnostics.
Invalid results produce INVALID_RESULT and leave the worker usable. Expected business
failures use a tool result with `isError: True`.

## Scheduling and diagnostics

One worker executes one handler at a time; separate named workers execute concurrently.
Synchronous callables run in an executor thread so the asyncio control loop can read
shutdown/cancellation messages. Thread affinity is not guaranteed between synchronous
factory, handler, and cleanup calls. Use async callables for resources requiring one
consistent event-loop thread. Blocking async code can stall that process; the host’s
independent timeout still terminates it. Non-cooperative sync code can also require
forced process termination. Cleanup is best effort at the configured shutdown deadline.

The private channel uses UTF-8 JSON lines. The runner reserves its original stdout and
redirects normal Python `print()` to stderr before importing application code. Use
`context.log()` or standard logging for diagnostics. Do not write directly to fd 1,
replace protocol streams, read stdin, or let child processes inherit stdout; those can
corrupt or consume the private protocol. This is unrelated to the external MCP transport.

There is no automatic retry, process restart, dependency management, descendant-process
supervisor, memory limit, or protocol frame byte limit in this alpha. Queue limits are
by count. Choose deployment limits before exposing untrusted traffic. Performance
benchmarks and production deployment images are separate work.
