# Security policy

MCPack executes trusted handler code. It is not a sandbox or an OAuth authorization
server. Read the README security boundaries and docs/http.md before exposing a service.
Use TLS at ingress, endpoint authentication, explicit network policy, secret management,
non-root containers and deployment CPU/memory/process limits as appropriate.

## Reporting a vulnerability

Do not publish credentials, customer data, exploit details or a working exploit in a
public issue. Use the repository's GitHub private vulnerability reporting feature
when enabled. If it is unavailable, ask a maintainer for a private reporting channel
without disclosing sensitive details publicly. Include affected versions, a minimal
reproduction, impact and relevant configuration in the private report.

## Maintenance expectations

Run `npm ci` followed by `npm run audit:dependencies` before approving a release.
The Dependency security workflow audits the root npm lockfile on pull requests,
main pushes and weekly; high/critical findings fail the check. Low/moderate
findings remain in its downloadable JSON report. Registry/audit failures also
fail the check; do not replace them with a passing empty report. npm staging and
the release-candidate workflow repeat the gate at publication time. Configure
the `Dependency audit` check as required in branch protection.

This does not scan OS/container packages, Python applications, secrets, unknown
vulnerabilities or arbitrary handler dependencies. Audit those separately. The
Support Desk app has its own lockfile: run
`npm audit --prefix examples/support-desk/app --audit-level=high`. Its 0.9.0 pin
must move to the published 0.9.1 patch before deployment; the source-built CI
variant exercises this checkout instead. Do not invent a lockfile integrity for
an unpublished package. Dependabot proposes npm, sample Python and Actions updates;
review them and retain the functional/package/deployment checks.

### Input limits (0.9.1)

MCPack uses the low-level SDK `Server` and its own AJV validation. It therefore
enforces its own tool argument budget before validation, rather than relying on
the high-level SDK's opt-in `maxToolInputElements` setting. Defaults are 10,000
object members/array elements in total and 64 nested containers. Oversized or
cyclic input is rejected before invoking a worker. Set positive integer
`maxToolInputElements`/`maxToolInputDepth` options on `MCPackRuntime.load()` or
`serveHttp()` for larger legitimate inputs; the HTTP CLI exposes corresponding
flags. Raising limits increases resource use. Byte, concurrency and timeout
limits remain necessary; this is not a complete DoS defense or a sandbox.

References: [SDK validation allocation advisory](https://github.com/advisories/GHSA-46jr-4wx8-v453)
and [HTTP body/batch advisory](https://github.com/advisories/GHSA-f897-62hf-6gxq).

### Repository and deployment controls

Enable private vulnerability reporting, dependency alerts, secret scanning and
push protection where available. Keep reviews and checks required on protected
branches. Use the existing staged trusted npm publication and maintainer 2FA;
avoid long-lived publishing tokens. Rebuild and scan container images regularly,
retain provenance/digests, and rotate any credential that has been exposed.
These repository settings are managed by maintainers, not changed by this patch.

### Support scope

The project is pre-1.0. Fixes target the current release/development line; there is no
LTS or guaranteed backport window. Review dependency/base-image updates and release
notes, pin the version you have tested, and validate upgrades in your environment.
No response-time SLA, independent security audit or penetration-test certification
is claimed. Third-party handler code and deployment configuration require their own review.
