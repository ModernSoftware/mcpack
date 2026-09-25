# Initial architecture decisions

## 1. MCPack owns native capabilities only

MCPack loads a native manifest and runs handler modules. Forge owns editing, bridge integrations, external MCP connections, composition and naming policies. A Forge bridge that imports an existing framework is not a native MCPack worker factory: the factory returns our documented handler contract.

This keeps the deployable native project independent of the Forge UI and avoids requiring a production aggregation gateway just to deploy authored tools.

## 2. Node/TypeScript host with persistent child processes

The host validates the manifest, owns MCP discovery, and schedules execution. Workers own native application dependencies and lifecycle. Child processes were chosen over worker threads to establish an isolation and lifecycle boundary reusable for other languages, and to keep handler stdout away from protocol traffic. They are not a security sandbox.

Node IPC is the first private adapter transport. Using MCP between a host and every native function process would add unnecessary discovery and protocol responsibilities to the handler contract. Python uses JSON-lines over private subprocess pipes; its runner redirects application stdout to stderr. A shared ProcessWorker scheduler owns both adapters’ queues, cancellation, deadlines, and termination. Python handlers implement the native factory contract without an MCP SDK.

One active invocation per worker is deliberate. Shared state has predictable sequential access. Multiple named workers provide concurrency and fault isolation; they are not replicas or a load-balanced pool. Replication requires an explicit policy for state, routing and startup costs, so it is deferred.

## 3. No implicit retry after ambiguous execution

A failed process or timeout does not prove an external side effect failed. The alpha retires affected workers and returns explicit errors. Automatic retry/restart requires a separate recovery contract and observability first.

## 4. One core for Forge and standalone serving

Forge’s `v0.10.0` prototype launches the MCPack CLI over stdio and forwards its native capabilities through Forge’s Streamable HTTP endpoint. The CLI wraps MCPackRuntime with an SDK server; other hosts can use the embedding API directly. The manifest, validation and result behavior therefore remain the same. SDK server construction is separate from runtime ownership so a host can control shutdown and eventual HTTP lifecycle.

Forge’s legacy custom execution protocol starts one process per execution and reads a single JSON response. It cannot consume this persistent-worker contract unchanged. Migration must explicitly replace its native execution path; bridges and remote sources stay behind Forge's own source interface.

## 5. Explicit protocol dependency

This implementation pins the official TypeScript server and client packages to 2.0.0. The stdio entry uses the SDK's `serveStdio` factory for protocol negotiation. Tests invoke actual discovery and calls using the official client. SDK behavior is separate from manifest and internal message versioning. Compatibility with all older clients has not been established.

## 6. Deployment readiness requires further evidence

Persistent processes amortize process startup and application initialization. Every call still incurs serialization, IPC, scheduling and validation overhead. No performance claim follows simply from the architecture. Later measurements must separate cold start, warm latency, throughput, memory per worker and behavior under saturation, using realistic I/O and CPU workloads.

The alpha now has a standalone HTTP host with admission authentication, input byte/concurrency limits, readiness and bounded shutdown. It does not have OAuth/tenant identity propagation, worker-output quotas, memory isolation or a process-tree supervisor. Those limitations must be addressed for the intended deployment environment before a production release.
