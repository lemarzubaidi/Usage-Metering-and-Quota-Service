# Load test results

Reproduce: see "Load test" in the main README (`docker compose --profile load run --rm loadtest`).

Machine used for these numbers: **2 CPU cores shared by the load generator, the service and PostgreSQL** (Node v22). On a normal computer the absolute numbers will be higher; what matters here is the correctness and the *before / after* comparison made on the same machine. Run-to-run noise is about +-10%.

Columns: latency in ms (p50 / p95 / p99 / max). "Correct" = after the run, every counter equals exactly the sum of the accepted requests, no limit was exceeded and there were no HTTP errors.

## First version (before optimisation)

Each consume ran 11 statements in its transaction (7 of them, COMMIT included, after the account's lock was taken). Database pool: 20 connections.

| Scenario | Requests | Concurrency | Seconds | Req/s | Latency ms p50 / p95 / p99 / max | Accepted / Rejected / Replayed | HTTP errors | Correct |
|---|---:|---:|---:|---:|---|---|---:|---|
| 0. baseline, 1 at a time | 500 | 1 | 3.5 | 144 | 6 / 11 / 15 / 17 | 500 / 0 / 0 | 0 | PASS |
| 1. 10 accounts, 20 users each | 10000 | 50 | 26.4 | 378 | 128 / 185 / 226 / 364 | 10000 / 0 / 0 | 0 | PASS |
| 2. 1 account, 20 users | 5000 | 50 | 29.8 | 168 | 285 / 434 / 539 / 869 | 5000 / 0 / 0 | 0 | PASS |
| 3. allowance 1000, many requests | 5000 | 100 | 19.8 | 252 | 385 / 526 / 600 / 660 | 1000 / 4000 / 0 | 0 | PASS |
| 4. one request_id x300 | 300 | 100 | 0.7 | 447 | 200 / 266 / 274 / 280 | 1 / 0 / 299 | 0 | PASS |

## Current version (after optimisation)

Each consume runs 4 statements plus BEGIN/COMMIT (after the account's lock is taken: 2 statements + COMMIT). Database pool: 10 connections.

| Scenario | Requests | Concurrency | Seconds | Req/s | Latency ms p50 / p95 / p99 / max | Accepted / Rejected / Replayed | HTTP errors | Correct |
|---|---:|---:|---:|---:|---|---|---:|---|
| 0. baseline, 1 at a time | 500 | 1 | 3.2 | 157 | 6 / 10 / 16 / 21 | 500 / 0 / 0 | 0 | PASS |
| 1. 10 accounts, 20 users each | 10000 | 50 | 23.4 | 427 | 116 / 155 / 180 / 218 | 10000 / 0 / 0 | 0 | PASS |
| 2. 1 account, 20 users | 5000 | 50 | 18.2 | 274 | 179 / 232 / 259 / 337 | 5000 / 0 / 0 | 0 | PASS |
| 3. allowance 1000, many requests | 5000 | 100 | 18.4 | 272 | 361 / 445 / 482 / 533 | 1000 / 4000 / 0 | 0 | PASS |
| 4. one request_id x300 | 300 | 100 | 0.9 | 322 | 300 / 333 / 346 / 354 | 1 / 0 / 299 | 0 | PASS |

Two further full runs of the current version gave scenario 2 = 267 and 236 req/s, scenario 1 = 443 and 426 req/s.

## What changed and what it showed

| Scenario | Before | After |
|---|---|---|
| 1. many accounts | 378 req/s, p95 185 ms | 427 req/s, p95 155 ms |
| 2. one hot account | 168 req/s, p95 434 ms, p99 539 ms | 274 req/s, p95 232 ms, p99 259 ms |
| 3. limit under contention | 252 req/s, p95 526 ms | 272 req/s, p95 445 ms |

(Scenario 4 lasts under one second, so its numbers are noise; it is there for the correctness check: exactly one request was counted.)

1. **Fewer round trips per request: 11 statements -> 6 (BEGIN, 4 statements, COMMIT).** The user lookup and the creation of the month's counters became one statement; the two row locks one statement; the "was this request_id answered?" check and the two plan reads one statement; the two counter updates and the history insert one statement. The decision logic and the guarantees are unchanged (`domain/rules.ts` was not touched, the same 79 tests pass, and the concurrency tests still fail if the `FOR UPDATE` is removed).
2. **The hot account gained the most (+63%)** because of what limits it: all requests of one account wait for the same account counter row, and the lock is held until COMMIT. Every statement run between the lock and COMMIT lengthens that wait for everybody else. The critical section went from 7 round trips (COMMIT included) to 3 (COMMIT included), so the queue moves faster.
3. **A smaller connection pool lowered tail latency.** Measured on a shorter run (`SCALE=0.4`) of scenario 2, hot account: pool 4 -> p99 246 ms, pool 8 -> p99 268 ms, pool 20 -> p99 467 ms; throughput was about the same (236-266 req/s). With 20 connections, up to 20 of them sit blocked in the database on the same row lock; with fewer, the waiting happens in Node's queue where it costs nothing. The default became 10 (`DB_POOL_MAX`).
4. **The limit is the CPU, not correctness.** With only 2 cores shared by three programs, nothing was tuned further. The remaining cost is mostly the per-request work in Node and PostgreSQL. Next steps if this mattered: run the load generator on another machine, measure on the real hardware, and consider the atomic `UPDATE ... WHERE consumed + n <= limit` variant (documented in the README as the alternative).
