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

The project is pre-1.0. Fixes target the current release/development line; there is no
LTS or guaranteed backport window. Review dependency/base-image updates and release
notes, pin the version you have tested, and validate upgrades in your environment.
No response-time SLA, independent security audit or penetration-test certification
is claimed. Third-party handler code and deployment configuration require their own review.
