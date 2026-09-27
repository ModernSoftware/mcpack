# Worker recovery

Recovery is disabled unless a worker has a `recovery` object. Existing manifests keep
their fail-stop behavior. Upgrade MCPack before using this field; older versions
reject it. Initial startup is always fail-fast: a missing interpreter, broken factory
or startup timeout rejects runtime startup and closes all workers.

```json
{
  "runtime": "python",
  "module": "./handlers.py",
  "maxConcurrent": 4,
  "recovery": {
    "maxRestarts": 3,
    "baseDelayMs": 250,
    "maxDelayMs": 10000,
    "resetAfterMs": 60000
  }
}
```

The values above are defaults when `recovery: {}` is supplied.

| Field          | Bounds and meaning                                                                  |
| -------------- | ----------------------------------------------------------------------------------- |
| `maxRestarts`  | 1–100 replacement launches per failure streak                                       |
| `baseDelayMs`  | 1–300000; initial backoff ceiling                                                   |
| `maxDelayMs`   | 1–300000; at least baseDelayMs                                                      |
| `resetAfterMs` | 1–86400000; uninterrupted ready time needed to reset the streak at the next failure |

For attempt index `n` starting at zero, the delay is rounded up from a random value
between half and all of `min(maxDelayMs, baseDelayMs * 2^n)`. Backoff starts after the
previous process exits. A successful replacement does not immediately reset the
budget: repeated quick crashes still exhaust it. Replacement startup errors/timeouts
consume attempts too. There is no automatic reset timer after exhaustion; investigate
and recreate the runtime/deployment deliberately.

## What happens to calls

1. A crash, protocol failure or active cancellation/deadline fails that process's
   active and queued calls under the existing error contracts. Ordinary handler,
   business, invalid-result and normal output-limit errors do not restart a worker.
2. The supervisor marks the worker `restarting` and rejects new calls with
   `WORKER_UNAVAILABLE`. It does not maintain a recovery queue.
3. The supervisor waits for the old process to exit, forcing termination when needed.
   Backoff then starts, followed by a fresh process and factory invocation.
4. Once the replacement is ready it accepts new calls. Other named workers remain
   independently callable throughout recovery.

There is no automatic retry, checkpoint, replay, rollback or idempotency store.
A failed call may already have written to a database or invoked another service.
Application handlers must implement durable idempotency/reconciliation where needed.
Factory startup must also tolerate repeated execution; recovery resets in-memory
state and reopens external connections. Credentials are reconstructed from the
configured environment sources on each launch; this is not live secret rotation.

## Health and shutdown

Existing health fields remain. A worker adds state `restarting` and a `recovery` object:

- `enabled`, `exhausted`: whether configured and whether the budget was consumed.
- `generation`: initial launch is 1, then increments for every replacement launch.
- `restartCount`: total replacement launches during this runtime's lifetime.
- `attempts`: launches in the current failure streak, reset lazily on a failure after
  the stable-ready interval.
- `lastFailureCode`: sanitized infrastructure code, retained after recovery for diagnosis.
- `nextRestartAt`: planned backoff deadline in epoch milliseconds, or null. This is
  not a promise of readiness; process startup has its own timeout.

Diagnostic byte counters accumulate across process generations. Application diagnostic
text is still potentially sensitive; it is not sanitized by the supervisor. Readiness
is false while any worker is restarting or failed. HTTP /healthz remains a liveness
probe; /readyz returns 503 during recovery and 200 after all workers are ready.

Shutdown cancels pending backoff, closes a replacement already starting, and waits
for supervision to settle. No replacement is spawned after shutdown. Process-generation
objects keep late messages/errors/timers from affecting a replacement. Recovery does
not supervise arbitrary descendants a handler spawns, provide a memory sandbox, or
replace container/orchestrator restart policies.
