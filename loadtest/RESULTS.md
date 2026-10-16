Date: 2026-10-16T13:50:53.030Z  |  Node v22.22.0  |  2 CPU cores (load generator and service share this machine)

| Scenario | Requests | Concurrency | Seconds | Req/s | Latency ms p50 / p95 / p99 / max | Accepted / Rejected / Replayed | HTTP errors | Correct |
|---|---:|---:|---:|---:|---|---|---:|---|
| 0. baseline, 1 at a time | 500 | 1 | 3.5 | 144 | 6 / 11 / 15 / 17 | 500 / 0 / 0 | 0 | PASS |
| 1. 10 accounts, 20 users each | 10000 | 50 | 26.4 | 378 | 128 / 185 / 226 / 364 | 10000 / 0 / 0 | 0 | PASS |
| 2. 1 account, 20 users | 5000 | 50 | 29.8 | 168 | 285 / 434 / 539 / 869 | 5000 / 0 / 0 | 0 | PASS |
| 3. allowance 1000, many requests | 5000 | 100 | 19.8 | 252 | 385 / 526 / 600 / 660 | 1000 / 4000 / 0 | 0 | PASS |
| 4. one request_id x300 | 300 | 100 | 0.7 | 447 | 200 / 266 / 274 / 280 | 1 / 0 / 299 | 0 | PASS |

All correctness checks passed.
