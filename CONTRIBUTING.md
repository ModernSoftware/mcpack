# Contributing to MCPack

Open an issue before implementation so the problem, scope and acceptance criteria are
clear. Link that issue from a focused pull request. All changes go through branches and
PRs; do not push changes directly to main.

## Local setup

Use Node 22+ and Python 3.11+. Python is required for the full test suite, even when your
change concerns Node workers.

```sh
npm ci
npm test
npm run test:package
npm run format:check
```

Use `npm run format` to apply the repository's formatting. Run the benchmark when a
change affects execution or transport overhead; report the machine and workload with
results rather than treating timing as a portable guarantee.

## Pull requests

Explain the problem, resulting behavior, and validation. Add meaningful regression
coverage when changing behavior. Preserve the shared Node/Python handler contracts or
explain the compatibility impact. Never commit credentials or application secrets.

Keep MCPack focused on native tools, resources and prompts. [Modern MCP Forge](https://github.com/ModernSoftware/modern-mcp-forge.git) owns development UI,
external MCP integrations and language bridges. Release publication is a separate owner
operation, described in [the release guide](docs/releasing.md).

Contributions are made under the repository's Apache-2.0 license.

## Integration test scheduling

`npm test` runs test files sequentially (`--test-concurrency=1`). Each file can
launch several persistent Node/Python processes; running many files together
creates competing interpreter startups on shared CI runners. Windows runs have
intermittently exceeded the unchanged 10-second worker startup deadline during
that overlap, despite passing formatting and the same tests on other runners.

This bounds suite-level process contention, not worker concurrency. The explicit
concurrent-call, cancellation, queue, recovery and timeout scenarios inside each
file still run with their original assertions. Production startup deadlines and
worker settings are unchanged. Run `npm test` locally to match CI scheduling.
