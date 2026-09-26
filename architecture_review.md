# MCPack architecture review and disposition

This records the independent review and the follow-up engineering validation for
issue #16. The initial review identified useful throughput and recovery limitations,
but its production-readiness conclusions were broader than the evidence supports.
The target remains a validated 0.9.0 release; this change does not declare stability.

## Concurrency: accepted as opt-in

Sequential access to factory state was a deliberate documented design decision.
It limits throughput for I/O-heavy handlers assigned to the same worker; independent
named workers already execute concurrently. Configurable multiplexing adds value
without making existing handlers concurrent by default.

`maxConcurrent` defaults to 1. The host bounds active calls and the FIFO waiting
queue separately. Handlers share factory state. Node async I/O can overlap; blocking
Node code still blocks its worker. Python sync handlers use threads and must be
thread-safe; async handlers share the event loop. Protocol reads have a separate
executor so a saturated handler pool cannot starve input.

The initial patch defaulted to 32, rejected all calls with maxQueue=0, and iterated a
mutating Python dictionary during shutdown. The follow-up fixes these issues and
preserves the boolean health field while adding activeCount. Tests now demonstrate
actual overlap, correlation of out-of-order results, bounds, mixed sync/async work,
thread-pool saturation, cancellation, crash isolation and cleanup.

Active cancellation/deadlines still retire the entire worker. Other executing calls
can already have produced side effects. This is documented and tested; operations
are not replayed. Named workers remain the process-level fault boundary.

## Recovery: separate future increment

Recovery must distinguish respawning a process from replaying an operation. Design
bounded restart attempts, backoff, readiness, observability and factory state reset.
Retain explicit errors for ambiguous in-flight operations and avoid automatic replay
of writes. Specify queued-call policy before implementing it.

## Security and interoperability: useful foundations, limited claims

Manifest validation, project-relative entrypoints, output budgets and diagnostic
quotas help constrain errors. They do not sandbox trusted handler code or impose
hard process memory/CPU limits. Node IPC deserializes before the host output check.

HTTP currently provides a service-token gate and custom admission callback, not a
complete OAuth resource server or per-user identity propagation. A gateway can own
parts of authorization, but its token validation, metadata/discovery, identity trust
boundary and backend bypass protections need deployment-level design and testing.
Using the official MCP SDK does not prove complete interoperability; supported
capabilities and protocol behavior still require client tests.

## Maintainability: focused follow-up

Improve dense tests through descriptive scenarios and reusable fixtures. Existing
tests already register cleanup with t.after; global beforeEach/afterEach hooks are
not inherently safer. Keep broad test restructuring separate from behavioral changes.
The concurrency suite uses separate fixture modules and bounded file gates to prove
overlap without inferring it from matching process IDs or short elapsed times.

## Deployment evidence before release

1. Complete recovery policy and failure tests in a separate issue/PR.
2. Validate DB/API pool limits, downstream throttling, memory and sustained load.
3. Validate authentication, TLS, proxy behavior and shutdown in the intended AWS setup.
4. Provide images containing only the supported runtimes required by the workload.
   Go/.NET support requires lifecycle, cancellation, framing and packaging contracts
   and cross-platform tests, not just a JSON message loop.
5. Run the Terraform support-agent experiment tracked in issue #14 against a release
   candidate. Pin the published 0.9.0 only after evidence supports that release.

A successful deployment or passing unit suite alone is not production certification.
