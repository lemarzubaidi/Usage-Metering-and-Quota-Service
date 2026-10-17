# Usage Metering and Quota Service

TypeScript + PostgreSQL service that meters usage and decides whether an action is allowed. Each calling application is an **account** with a shared monthly allowance; each **user** of the account has an individual allowance. Every consume request is checked against both, the decision is recorded, and counters stay exact under concurrency.

## Run

Requirement: Docker.

```bash
docker compose up --build
```

Starts `db` (PostgreSQL 16), `service` (API on http://localhost:3000; creates the tables and the four predefined plans by itself at start-up) and `client` (example scenario, prints each decision, ends with `All checks passed.`).

```bash
docker compose logs client                         # client output again
docker compose run --rm client                     # run the scenario again
docker compose --profile test run --rm tests       # automated tests
docker compose --profile load run --rm loadtest    # load test
docker compose down -v                             # stop and delete data
```

Settings (see `.env.example`): `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `ADMIN_API_KEY` (default `dev-admin-key-change-me`), `PORT`, `LOG_LEVEL`, `DB_POOL_MAX`.

Without Docker (Node 22 + your own PostgreSQL):

```bash
cd service && npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/metering ADMIN_API_KEY=some-long-secret
npm run build && npm start
npm test
```

## Model

| Concept | Meaning |
|---------|---------|
| Account | A calling application, identified by its API key. Has one account plan. |
| User | A user of an account. `user_id` is the caller's own id, unique inside the account. Has one user plan. |
| Plan | `monthly_allowance` (units per UTC month) and `max_per_request`, with scope `account` or `user`. |
| Predefined plans | `Starter` (account 10,000 / 100), `Pro` (account 100,000 / 1,000), `Basic` (user 1,000 / 20), `Premium` (user 10,000 / 200). Read-only. |
| Custom plans | Created by an account (`POST /v1/plans`); visible and assignable only by it. |

The account allowance is its own number, not the sum of its users' allowances. Consumption is what is summed: an accepted request adds its units to the user counter and the account counter.

### API keys

- The operator creates an account with `POST /admin/accounts` (protected by `ADMIN_API_KEY`). The key is `sk_` + 43 random characters (256 bits) and is **shown only once**.
- Only the SHA-256 hash is stored (indexed lookup; a random 256-bit key does not need bcrypt).
- `/v1/*` requires `Authorization: Bearer <key>`. The account comes from the key only; unknown body fields such as `account_id` are rejected with 400.

## Rules

A consume of `N` units is accepted only if all four hold (limits inclusive):

1. `N <= user.max_per_request`
2. `N <= account.max_per_request`
3. `consumed_user + N <= user.monthly_allowance`
4. `consumed_account + N <= account.monthly_allowance`

- Check order is fixed (1, 2, 3, 4). Every violated rule is returned in `violations`; the first is the headline (`rejected_by`, `rule`).
- A rejection consumes nothing.
- Months are UTC calendar months; a new month is a new counter row.
- `remaining = max(0, allowance - consumed)`, computed on read.

## API

Errors: `{ "error": { "code", "message", "details" } }`.

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness |
| `POST /admin/accounts` | Create account (admin key), returns API key once |
| `GET /v1/account`, `PUT /v1/account/plan` | Read account / assign account plan |
| `GET /v1/plans`, `GET /v1/plans/:id`, `POST /v1/plans`, `PATCH /v1/plans/:id` | List, read, create, edit (custom only) |
| `POST /v1/users`, `GET /v1/users`, `GET /v1/users/:userId`, `PUT /v1/users/:userId/plan` | Users and their plan |
| `POST /v1/consume` | Ask to consume units |
| `GET /v1/usage?user_id&period&limit&offset` | Consumption and remaining for the account and one user, or all users |
| `GET /v1/history?user_id&period&decision&limit&cursor` | Accepted and rejected requests, newest first |

Status codes: `200` processed (consume accepted **and** rejected), `201` created, `400` invalid input, `401` bad key, `403` editing a predefined plan, `404` missing or another account's data, `409` conflict (`request_id` reused with different data, duplicate user or plan name), `500` unexpected.

```bash
curl -s -X POST localhost:3000/admin/accounts -H "Authorization: Bearer dev-admin-key-change-me" \
     -H "content-type: application/json" -d '{"name":"DocFlow"}'
curl -s -X POST localhost:3000/v1/users -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
     -d '{"user_id":"ahmad"}'
curl -s -X POST localhost:3000/v1/consume -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
     -d '{"user_id":"ahmad","request_id":"req-1","units":15}'
```

```json
{ "accepted": true, "request_id": "req-1", "user_id": "ahmad", "units": 15, "period": "2026-10",
  "remaining": { "user": 985, "account": 9985 }, "replayed": false }
```

```json
{ "accepted": false, "request_id": "req-2", "user_id": "ahmad", "units": 25, "period": "2026-10",
  "rejected_by": "user", "rule": "max_per_request",
  "violations": [ { "level": "user", "rule": "max_per_request", "limit": 20, "requested": 25 } ],
  "remaining": { "user": 985, "account": 9985 }, "replayed": false }
```

## Plan changes

- A new plan assignment or an edit of a custom plan applies to the **next** request (plans are read inside every consume transaction).
- Editing a custom plan affects everything that uses it.
- Consumption is never reset: counters store only what was consumed. 90 used, moved from a 100 plan to a 200 plan, leaves 110.
- If an allowance is lowered below consumption, `remaining` is 0 and requests are rejected.
- History does not change: each log row stores a JSON snapshot of the limits and numbers used.
- Plans must be visible to the caller and of the right scope (another account's plan: 404, wrong scope: 400; also enforced by a composite foreign key).

## Retries

- Each consume carries a client-chosen `request_id`, unique per account (`UNIQUE (account_id, request_id)`).
- Same `request_id`, user and units: the saved answer is returned with `"replayed": true`, nothing is counted again (also for rejections).
- Same `request_id`, different user or units: `409 request_id_conflict`.
- A new attempt (for example after a plan change) needs a new `request_id`.

## Concurrency

One transaction per consume (`services/consume.ts`, SQL in `repositories/consumption.ts`):

1. Resolve the user; create the month's counter rows (`ON CONFLICT DO NOTHING`).
2. Lock the account counter row, then the user counter row (`SELECT ... FOR UPDATE`, account first, so no deadlock).
3. After the locks: check the `request_id`, read the plans, evaluate the rules (`domain/rules.ts`).
4. Update both counters (if accepted) and insert the `request_log` row in one statement; `COMMIT`.

The concurrency tests fail if `FOR UPDATE` is removed.

## Database

Migrations in `service/migrations/` run at start-up (one transaction each, tracked in `schema_migrations`, advisory lock). Tables: `plans`, `accounts`, `users`, `usage_counters` (`user_id IS NULL` = account counter), `request_log`.

Enforced by the database: plan scope and account isolation (composite foreign keys), one counter per month (partial unique indexes), idempotency (`UNIQUE`), valid values (`CHECK`). `service/scripts/verify_schema.sql` demonstrates 18 of these checks.

## Tests

79 tests against a real PostgreSQL (`cd service && npm test`, or the `tests` compose profile): rules and boundaries, API key validation, setup and validation, consume, idempotency, plan changes, concurrency, usage and history, account isolation.

## Load test

`loadtest/src/load.ts` (Node only). Checks speed and correctness: after the run every counter must equal the sum of accepted requests.

```bash
docker compose up -d db service
docker compose --profile load run --rm loadtest
SCALE=0.2 docker compose --profile load run --rm loadtest
```

Dependencies: Docker, or Node 22 + npm and a running service (`cd loadtest && npm install && npm run dev`).

Results on 2 shared CPU cores (full tables, before and after, in [`loadtest/RESULTS.md`](loadtest/RESULTS.md)):

| Scenario | Req/s | p99 ms | Accepted / Rejected / Replayed | Correct |
|---|---:|---:|---|---|
| 0. baseline, 1 at a time | 157 | 16 | 500 / 0 / 0 | PASS |
| 1. 10 accounts, 20 users each | 427 | 180 | 10000 / 0 / 0 | PASS |
| 2. one hot account | 274 | 259 | 5000 / 0 / 0 | PASS |
| 3. allowance 1000, 5000 requests | 272 | 482 | 1000 / 4000 / 0 | PASS |
| 4. one `request_id` x300 | 322 | 346 | 1 / 0 / 299 | PASS |

Findings: requests of one account queue on its counter row lock, held until `COMMIT`. Merging statements (11 to 6 round trips) raised the hot account from 168 to 274 req/s (p99 539 to 259 ms). A smaller pool (20 to 10) lowered tail latency.

## Extending the rules

Add a column to `plans`, a counter, and one check in `evaluate()` (`domain/rules.ts`) with its place in the fixed order. It works like the existing rules: a request must satisfy all, any can reject, all violations are reported.

## Assumptions

- Accounts are created by the operator through an admin endpoint.
- Users are registered first (`POST /v1/users`); an unknown user is 404.
- Units are positive integers; an allowance may be 0.
- Months are UTC; a request belongs to the month the server processes it.
- The account allowance is independent of the sum of its users' allowances.
- One service instance and one PostgreSQL.

## Design decisions

| Decision | Why | Alternative |
|----------|-----|-------------|
| Counters store consumption only | Plan changes never wipe usage | Storing the limit duplicates data |
| Counter rows, not summing the log | O(1) read; the row is the lock target | Summing is slow and hard to lock |
| `SELECT FOR UPDATE` in a transaction | Simple, correct, testable | Atomic `UPDATE ... WHERE consumed + n <= limit` needs care for all-or-nothing and for reporting the rule |
| Rejection is HTTP 200 | A business answer, recorded and replayed | 429 mixes business decisions with rate limiting |
| 404 for other accounts' data | No leak of what exists | 403 leaks existence |
| SHA-256 for keys | High entropy, indexed lookup | bcrypt is for passwords |
| Idempotency by `UNIQUE` | Survives restarts and instances | In-memory cache is lost |
| Plans as columns | Only two rules; constrainable | JSON is flexible but unvalidated |
| Plain `pg` + SQL | Locks and transactions stay visible | ORM hides them |
| Migrations at start-up | `docker compose up` needs no manual step | Separate migrate job |

## Limitations

- No key rotation or revocation; one admin key; no account or user deletion.
- No rate limiting or TLS.
- One account's throughput is limited by its counter lock (about 270 req/s on the test machine).
- `request_log` and `usage_counters` grow forever.
- Replayed answers show `remaining` as it was originally.
- Past-month usage shows that month's consumption with today's limits.
- Plans cannot be deleted or change scope.
- Load-test numbers come from a small shared machine; repeat on target hardware.
