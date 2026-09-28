# MCPack and Modern MCP Forge roadmap

This is a direction of travel, not a delivery-date commitment. Track implementation
through issues and reviewed PRs in each repository.

## v0.9.0 scope — implemented and frozen

- Manifest/handler/error contracts and persistent Node/Python workers.
- Stdio and stateless Streamable HTTP, embedding API and installed-package tests.
- Bounded opt-in concurrency, FIFO queues, deadlines, cancellation, shutdown,
  output/diagnostic limits and opt-in worker recovery without operation replay.
- Service-token/custom admission auth, Host/Origin checks, probes and request limits.
- Linux/Windows CI, Docker reference, reproducible benchmarks and staged publishing.
- Support Desk local/AWS sample, 10K orders, S3 evidence, refund simulator and
  deterministic agent approval/reconciliation tests.
- Forge native integration prototype verified; this is not yet its final project UI.

## Next — distribute and gather operational evidence

Approve v0.9.0, pin the example to that exact npm release, retain source-built CI,
and collect sustained-load, full process-tree memory, restart and rolling-update
results. Fix demonstrated defects before adding scope. The maintainer has reported
AWS DNS/token/Inspector/Bedrock interoperability; that evidence is distinct from
capacity, failover or security certification.

## MCPack follow-up

1. .NET runner with contract, cancellation, framing, lifecycle and packaging parity.
2. Go runner with the same acceptance criteria.
3. Evaluate request identity propagation and broader MCP capabilities against actual
   consumer needs. Do not imply that a service token establishes tenant isolation.
4. Consider worker pools, memory controls and operational tooling only with measured
   requirements and explicit failure semantics.

## Forge follow-up

Work lives in [Modern MCP Forge](https://github.com/ModernSoftware/modern-mcp-forge).
Its `v0.10.0` integration prototype is a step toward:

1. Project-level native manifests/handlers in the developer's repo, Monaco editing,
   diagnostics, worker health and deliberate reload. Verify standalone parity and
   explicitly migrate old native definitions rather than silently changing their ABI.
2. External MCP sources with clear authentication ownership and lifecycle handling.
3. Developer-authored language bridges, starting with TypeScript/Python.
4. One development endpoint combining native, bridged and external capabilities,
   preserving source schemas/identity while handling name and URI collisions.
5. Native MCPack export/deployment independent of the UI, plus tutorials and the
   real application walkthrough.

External MCP/bridge aggregation remains Forge's responsibility. MCPack manifests
and deployments remain native-only; .NET/Go are deferred beyond v0.9.0.
