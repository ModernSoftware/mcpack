# Reliability and performance baseline

Test-run durations include process startup, fixture setup, failure injection, and teardown.
They are not per-tool latency measurements. The benchmark separates these costs:

```sh
npm ci
npm run benchmark -- --iterations 100 --output .benchmark/results.json
```

Requires Node 22+ and Python 3.11+. Run from the repository, outside the test suite, on an
otherwise idle machine. Repeat runs on the same machine before drawing conclusions.
Do not compare a Windows laptop's wall-clock results with a Linux CI runner as a regression.

The JSON records environment details, two cold-start measurements, and 32 warm cases:
Node/Python × direct runtime/HTTP × no-op/16-KiB echo/5-ms simulated I/O/50,000 loop
iterations × 1/8 concurrent callers. Each case has five untimed warmup calls and reports
p50/p95/p99/max latency plus completed calls per second. Warm latency includes queue wait
and validation; HTTP also includes the official client, SDK server, and loopback network.
Each language has one worker; concurrent callers do not create replicas. CPU work is a
synthetic workload, not a fair language-performance comparison.

Runtime cold start includes manifest load and both workers' readiness. HTTP cold start
also includes listener startup and client negotiation. Samples are end-to-end wall-clock
measurements, not isolated serialization costs. The report's RSS is only the Node host's
sampled RSS, excluding worker memory; it is not total deployment memory or a memory leak test.

A separate saturation check uses maxQueue 2 and twelve simultaneous calls to one worker:
three must succeed and nine must return QUEUE_FULL. Failures are not hidden inside latency
percentiles. Reliability tests separately cover worker crashes, startup rollback, queued
and active cancellation, stuck handlers/cleanup, invalid results, missing interpreters,
HTTP request limits, authorization stalls, disconnected clients, and bounded shutdown.

CI smoke-tests the harness with five iterations to catch regressions in the measurement
code. It does not enforce timing thresholds. The release-candidate workflow records a
100-iteration report alongside the tarball and its digest. Before a production claim,
measure real DB/API workloads, longer saturation/soak runs, total process-tree memory,
output quotas, TLS/proxy behavior, and application idempotency under failures.

## Initial local measurement

[Raw baseline](benchmarks/baseline-linux.json), recorded on 2026-09-25T18:54:07.411Z with v24.19.0 and Python 3.12.14. This is one Linux run with 100 measured calls per case and five warmups; it is not a release performance guarantee. The JSON includes a source fingerprint for reproducibility.

| Path    | Worker | No-op p50 (ms) | No-op p95 (ms) |
| ------- | ------ | -------------: | -------------: |
| runtime | node   |          0.215 |          0.339 |
| runtime | python |          0.134 |          0.317 |
| http    | node   |          2.657 |          3.747 |
| http    | python |          2.193 |          2.628 |

Cold start was 126.8 ms for the native runtime and 129.4 ms including HTTP client negotiation. Both start both worker languages. Saturation returned 3 successes and 9 QUEUE_FULL rejections as specified.

## v0.9.0 candidate baseline (2026-09-28)

[Raw report](benchmarks/v0.9.0-linux.json) records the source fingerprint, environment
and every case. Linux 6.18.44; AMD EPYC 9V74 host reporting 9 logical CPUs; Node
24.19.0; Python 3.12.14. This is an execution workspace, not a dedicated benchmark
host: effective CPU/memory quotas and background contention were not captured.
100 measured calls per case, five warmups, one worker per language with default
sequential execution. Concurrency 8 measures callers waiting/competing, not eight
active handlers per worker. HTTP uses loopback without TLS, authentication or a DB.

Selected **single-caller no-op** results (full matrix in JSON):

| Path    | Worker | p50 ms | p95 ms | p99 ms | Completed calls/s |
| ------- | ------ | -----: | -----: | -----: | ----------------: |
| runtime | node   |  0.153 |  0.455 |  0.682 |            4973.8 |
| runtime | python |  0.212 |  0.298 |  0.339 |            4399.2 |
| http    | node   |  2.872 |  5.456 |  6.002 |             313.5 |
| http    | python |  2.195 |  2.761 |  2.911 |             440.0 |

Cold start: 122.8 ms for the runtime and 159.8 ms including HTTP negotiation.
Both include two worker languages. Saturation: 3 successes and 9 expected QUEUE_FULL
rejections. Host RSS excludes workers and is not a deployment-memory budget.

## Support Desk application smoke measurement

Maintainer-reported on 2026-09-28 using `examples/support-desk/test/load.mjs`:

| Requests | Concurrent callers | Failures |    p50 |    p95 |    p99 | Requests/s |
| -------: | -----------------: | -------: | -----: | -----: | -----: | ---------: |
|      100 |                  4 |        0 | 202 ms | 452 ms | 886 ms |      18.09 |

This workload invokes `get_order_details` over MCP HTTP and queries PostgreSQL;
it does not measure every tool, S3 or model latency. The supplied output did not
record the endpoint, exact commit, server sizing or client hardware. The maintainer
also reported AWS and local success, but we cannot assign this specific measurement
to one topology from its JSON alone. Treat it as an illustrative smoke result, not
a controlled comparison with the synthetic benchmark or a maximum-capacity claim.

Reproduce from a client outside the deployment network using the same version:

```sh
# Set MCP_URL and MCPACK_HTTP_TOKEN securely in the environment first.
REQUESTS=10000 CONCURRENCY=4 node examples/support-desk/test/load.mjs
```

The harness accepts 1–10,000 requests and concurrency 1–32. Record client/server
versions, commit/image digest, region, TLS/network path, task CPU/memory, replica
count, worker/pool settings, dataset and errors. Repeat at selected concurrency
levels while observing all host/worker memory and downstream pool pressure. A fixed
request-count run is not a duration-based soak test, nor does it measure maximum
TCP connections or prove linear replica scaling. Do not run saturation against a
shared service without coordinating its load budget.

## Catalog and security coverage

The Support Desk integration exercises 9 tools, 2 resources and 2 prompts. The
manifest has no explicit total count limit, but large catalogs are not benchmarked.
Discovery size, client support and process memory impose practical limits. Default
HTTP admission (128) and configurable worker concurrency (default 1) are ceilings
on in-flight work, not throughput guarantees. See the README capacity table.

Security/reliability tests verify behaviors such as rejected bearer credentials and
origins, bounded bodies/outputs, queue admission, worker failure isolation and no
automatic operation replay. They do not establish multi-tenant authorization or
constitute an independent penetration test.
