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
