# Implementation sequence

## Increment 1 — Native contracts and Node runtime (completed)

Versioned manifest; explicit factory, handler, result and error contracts; persistent named Node processes; bounded queues; deadline/cancellation semantics; stdio server; embedding API; a native example; lifecycle/protocol tests; package and CI scaffolding.

Acceptance: native discovery and invocation work through a real MCP client; state persists without launching per call; separate workers run independently; failures and shutdown settle outstanding callers.

## Increment 2 — Forge consumes MCPack for native projects (prototype verified)

Inspect current project persistence and Monaco editing flow. Add a native source adapter using MCPackRuntime. Keep modules in the developer's repository, compile TS explicitly, show worker diagnostics/state, and restart deliberately after edits. Verify Forge and standalone execution produce the same discovery and results from the same files. Migrate existing custom-native projects explicitly with a manifest conversion, rather than silently changing their ABI.

## Python native workers (completed)

Persistent Python 3.11+ workers use the same host scheduler and native result contracts. Cover both runtimes with lifecycle tests; verify a mixed-language server and the installed npm artifact. Keep Forge’s tested `v0.10.0` branch unchanged and run its pinned regression suite against MCPack changes.

After this increment: measure the mixed-runtime implementation and harden deployment, then return to Forge project integration. The dedicated native prototype view is not the final project/source design.

## Forge external MCP sources and language bridges (subsequent integration)

Define Forge's source interface for discovery, execution, refresh, health and disposal. Add remote MCP connection configuration and authentication ownership. Implement TypeScript/Python bridges as developer-authored adapters. Preserve source definitions and schemas, track original identity, handle names and resource URI collisions, and maintain reversible routing aliases. Add capability-change handling and session reconnection. These sources remain outside MCPack manifests and deployments.

## Current increment — HTTP and release foundation

Add stateless Streamable HTTP using the same native runtime, service-token/custom admission authentication, request limits, health/readiness and shutdown handling. Add a reproducible benchmark and release-candidate/npm-alpha workflows. Identity propagation, OAuth, worker recovery, output/memory quotas and extended soak measurements remain follow-up work. This is an alpha release foundation, not a production-readiness claim.

## Increment 5 — Additional runtimes and deployable artifacts

Python worker transport and dependency conventions are covered by the current increment; defer .NET until Node/Python contracts are proven. Produce minimal base images per runtime combination with pinned dependencies, non-root execution and health checks. Keep project code and dependencies visible and independent of Forge. Decide license and distribution before publishing packages/images.

## Increment 6 — Evidence and public reference project

Benchmark cold/warm latency, saturation, memory, worker death and realistic DB/API workloads. Expand the original incident/evidence benchmark across native MCPack, FastMCP and official SDK sources in Forge. Document the actual edit/test/deploy workflow and its limitations before writing the Medium article.
