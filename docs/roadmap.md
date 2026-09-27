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

Add stateless Streamable HTTP using the same native runtime, service-token/custom admission authentication, request limits, health/readiness and shutdown handling. Add a reproducible benchmark and release-candidate/npm-alpha workflows. Identity propagation, OAuth, worker recovery, hard process-memory quotas and extended soak measurements remain follow-up work. Output budgets are covered by the hardening increment below. This is an alpha release foundation, not a production-readiness claim.

## Increment 5 — Additional runtimes and deployable artifacts

Python worker transport and dependency conventions are covered by the current increment; defer .NET until Node/Python contracts are proven. Produce minimal base images per runtime combination with pinned dependencies, non-root execution and health checks. Keep project code and dependencies visible and independent of Forge. Decide license and distribution before publishing packages/images.

## Increment 6 — Evidence and public reference project

Benchmark cold/warm latency, saturation, memory, worker death and realistic DB/API workloads. Expand the original incident/evidence benchmark across native MCPack, FastMCP and official SDK sources in Forge. Document the actual edit/test/deploy workflow and its limitations before writing the Medium article.

## Hardening toward 0.9.0 and AWS validation

The output-hardening increment added finite worker response budgets, bounded Python frame parsing,
diagnostic delivery quotas/counters, and documented failure/compatibility semantics.
Node IPC deserialization and application allocation remain outside hard memory limits.

Follow with deliberate worker recovery policy, realistic DB/API load and fault tests,
process-tree memory measurement, authentication/TLS/proxy deployment validation, and
stable manifest/error/health interfaces. Forge continues consuming supported public
interfaces; external sources and bridges remain Forge concerns.

Track the AWS support-agent experiment in [issue #14](https://github.com/ModernSoftware/mcpack/issues/14):
a small Terraform project, database-backed tools, scoped S3 access, and the same native
project usable from Forge. Validate a candidate before declaring 0.9.0, then pin the
example to the published 0.9.0 package. Evidence must include failure/recovery and sustained
operation, not just a successful deployment. Infrastructure selection, Terraform planning,
and resource creation are a later task; this increment does not provision AWS resources.

Opt-in Node/Python concurrency retains sequential defaults, bounds active and queued
calls separately, and tests overlap, out-of-order results, shared capability capacity,
Python thread-pool saturation, cancellation, worker death and concurrent cleanup.
Worker recovery is delivered in the subsequent deployment-readiness increment; automatic operation retry remains out of scope.

## Deployment readiness (issue #18)

Opt-in supervisor recovery, bounded restart budgets/backoff, health/readiness,
security regression tests and a non-root Node/Python reference image prepare a
release candidate for issue #14. Initial startup remains fail-fast; calls are never
replayed. The AWS experiment must still validate real authentication/TLS/proxy setup,
DB/S3/API access, sustained load, memory and ambiguous-write behavior before 0.9.0.
