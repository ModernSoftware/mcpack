# Implementation sequence

## Increment 1 — Native contracts and Node runtime (this branch)

Versioned manifest; explicit factory, handler, result and error contracts; persistent named Node processes; bounded queues; deadline/cancellation semantics; stdio server; embedding API; a native example; lifecycle/protocol tests; package and CI scaffolding.

Acceptance: native discovery and invocation work through a real MCP client; state persists without launching per call; separate workers run independently; failures and shutdown settle outstanding callers.

## Increment 2 — Forge consumes MCPack for native projects

Inspect current project persistence and Monaco editing flow. Add a native source adapter using MCPackRuntime. Keep modules in the developer's repository, compile TS explicitly, show worker diagnostics/state, and restart deliberately after edits. Verify Forge and standalone execution produce the same discovery and results from the same files. Migrate existing custom-native projects explicitly with a manifest conversion, rather than silently changing their ABI.

## Increment 3 — Forge external MCP sources and language bridges

Define Forge's source interface for discovery, execution, refresh, health and disposal. Add remote MCP connection configuration and authentication ownership. Implement TypeScript/Python bridges as developer-authored adapters. Preserve source definitions and schemas, track original identity, handle names and resource URI collisions, and maintain reversible routing aliases. Add capability-change handling and session reconnection. These sources remain outside MCPack manifests and deployments.

## Increment 4 — Production transport and supervision

Add Streamable HTTP using the same native runtime, with explicit lifecycle/session ownership and authenticated request context. Define authentication/authorization integration, credential boundaries, payload limits, health/readiness, structured diagnostics, worker recovery and shutdown behavior. Test transport errors and identity propagation; successful stdio tests alone do not establish HTTP security equivalence.

## Increment 5 — Additional runtimes and deployable artifacts

Implement Python worker transport and dependency conventions; defer .NET until Node/Python contracts are proven. Produce minimal base images per runtime combination with pinned dependencies, non-root execution and health checks. Keep project code and dependencies visible and independent of Forge. Decide license and distribution before publishing packages/images.

## Increment 6 — Evidence and public reference project

Benchmark cold/warm latency, saturation, memory, worker death and realistic DB/API workloads. Expand the original incident/evidence benchmark across native MCPack, FastMCP and official SDK sources in Forge. Document the actual edit/test/deploy workflow and its limitations before writing the Medium article.
