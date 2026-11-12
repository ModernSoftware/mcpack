# Changelog

## 0.9.1 — security patch preparation

Publication remains subject to the staged npm release workflow and maintainer approval.

- Update the MCP client/server SDK to 2.3.0 and raise AJV/Zod minimums; refresh the
  runtime lockfile to patched dependencies.
- Bound tool arguments before AJV validation and worker serialization: 10,000
  combined array elements/object members and 64 container levels by default.
  Applies to the embedded API, stdio and HTTP. Oversized inputs now fail with
  `INVALID_ARGUMENTS`; applications with larger legitimate payloads can configure
  the limits through runtime/HTTP options.
- Apply the configured HTTP body cap inside the SDK too; the patched SDK rejects
  JSON-RPC batches longer than 100 messages.
- Audit runtime dependencies on PRs, main pushes, weekly, and before npm staging;
  high/critical advisories and audit-service failures block the check. Keep full
  reports for review and propose dependency updates with Dependabot.

The Support Desk registry example still consumes 0.9.0 until this patch is
published. Update its pin/lock and rerun its deployment checks before using it
as a patched production deployment.

## 0.9.0

First non-prerelease distribution of the Node/Python runtime. Available on npm
only after the release tag has been staged and approved by the maintainer.
Version 0.x continues to allow API evolution; pin a version and review changes
before upgrading. This is not a 1.0 compatibility or universal capacity promise.

- Serve native tools, resources and prompts from one versioned manifest over
  stdio or stateless Streamable HTTP; embed the same runtime in another host.
- Persistent Node and Python workers with explicit environments, per-worker
  interpreters, opt-in bounded concurrency and FIFO waiting queues.
- Invocation deadlines, cancellation, bounded cleanup, diagnostic/output limits,
  crash isolation and opt-in bounded worker restart without operation replay.
- HTTP service-token or custom admission authorization, Host/Origin validation,
  request limits and liveness/readiness probes. TLS is provided by deployment ingress.
- Non-root Docker reference, reproducible benchmark harness, installed-package
  tests and Linux/Windows CI.
- Support Desk sample: Compose or Terraform/AWS, PostgreSQL/S3/refund simulator,
  mixed runtime tools and a Strands agent with deterministic evidence/approval checks.
- Numbered alpha and non-prerelease packages use staged npm trusted publishing,
  with manual maintainer approval; no permanent npm token is required in CI.

Known scope: trusted handler code, endpoint-level service identity, static
capabilities and text/JSON results. No built-in OAuth issuer, tenant identity
propagation, per-tool authorization, runtime sandbox, .NET or Go runner.
See the README, security policy and deployment guide before exposing a service.

## 0.1.0-alpha.1

Initial npm bootstrap publication. Development continued through reviewed PRs;
0.9.0 collects the runtime and deployment work completed since that alpha.
