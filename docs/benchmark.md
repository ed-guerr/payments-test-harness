# Benchmark

Loopback throughput and ack latency for the wire protocol (moved out of the
README in the 2026-11 README cut).

`npm run bench` starts a fresh backend cluster, sends sequential
`TransferFunds` (one in flight) from a single client, and reports throughput
plus ack-latency percentiles. Each op is a full round trip: framed request
out, C handler executes (SQLite read → validate → commit), framed ack back.
500 measured ops after 50 warmup, three runs on the author's laptop
(Apple Silicon, macOS):

| ops | throughput | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| 500 | 8,233/s | 99 μs | 165 μs | 271 μs | 2.59 ms |
| 500 | 8,677/s | 90 μs | 161 μs | 350 μs | 2.70 ms |
| 500 | 8,445/s | 96 μs | 150 μs | 389 μs | 2.65 ms |

Read this as "protocol + single-threaded SQLite commit cost over loopback on
one machine", not a scaling claim: each run is one client against a fresh
three-process cluster.
