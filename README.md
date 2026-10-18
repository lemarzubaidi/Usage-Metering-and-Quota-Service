# Usage Metering and Quota Service

A backend service (TypeScript, Fastify, PostgreSQL) that other applications call before letting a user do something. Each calling application is an **account** with a shared monthly allowance. Each **user** of that account has an individual allowance. A consume request is accepted only if the account's plan and the user's plan both allow it. The decision is stored, and the counters stay exact when many requests arrive at once.

## Run it

You need Docker.

```bash
docker compose up --build
```

This starts PostgreSQL, the service on http://localhost:3000 and the example client. The service creates its tables and the four predefined plans by itself when it starts. The client waits for the service, runs a scenario, prints every decision and ends with `All checks passed.`

```bash
docker compose logs client                         # the client output again
docker compose run --rm client                     # run the scenario again (new account each time)
docker compose --profile test run --rm tests       # automated tests
docker compose --profile load run --rm loadtest    # load test
docker compose down -v                             # stop and delete the data
```

Settings (all optional, see `.env.example`): `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `ADMIN_API_KEY` (default `dev-admin-key-change-me`, change it anywhere real), `PORT`, `LOG_LEVEL`, `DB_POOL_MAX`.

Without Docker (Node 22 and your own PostgreSQL):

```bash
cd service && npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/metering ADMIN_API_KEY=some-long-secret
npm run build && npm start
npm test
```

### The example client

`client/src/main.ts` plays an application calling the service with an account key. Two users of the same account have different plans: alice (40 per month, 30 per request) and bob (100 per month, 50 per request), under an account plan of 60 per month and 50 per request.

1. alice asks for 30: accepted.
2. alice asks for 15 more: rejected by her own monthly limit.
3. bob asks for 30: accepted, which uses up the account's 60. bob asks for 10 more: rejected by the **account** limit, although he has used only 30 of his 100.
4. alice's first request is sent again with the same `request_id`: the saved answer comes back and nothing is counted twice.
5. The account plan is raised from 60 to 200 and the call from step 3 is accepted.
6. alice is moved to bob's plan and her rejected call now works. The 30 units she already used still count.

The client code is the same before and after steps 5 and 6. Only the plans in the service change.

## The model

- **Account**: an application. It is identified by its API key and has one account plan.
- **User**: a user of an account. `user_id` is the caller's own identifier (for example `"ahmad"`) and only has to be unique inside that account. A user has one user plan.
- **Plan**: `monthly_allowance` (units per UTC month) and `max_per_request`. A plan has a scope, `account` or `user`, and can only be assigned to something of the same scope.
- **Predefined plans** (read-only, created at start-up): `Starter` (account, 10,000 per month, 100 per request), `Pro` (account, 100,000 / 1,000), `Basic` (user, 1,000 / 20) and `Premium` (user, 10,000 / 200).
- **Custom plans**: an account can create and edit its own plans and assign them to itself or its users. Only that account can see them.

The account allowance is its own number. It is not the sum of its users' allowances. What is summed is usage: every accepted request adds the same units to the user's counter and to the account's counter.

### API keys

The operator creates an account with `POST /admin/accounts`, protected by the `ADMIN_API_KEY` environment variable. The response contains the account's API key, shown once. A key is `sk_` plus 43 random characters (256 bits from the system's secure random generator). Only its SHA-256 hash is stored, so nobody can read a key back from the database.

Every `/v1/*` call sends `Authorization: Bearer <key>`. The key decides the account. No endpoint takes an account id from the request, and a body with unknown fields (for example `account_id`) is rejected with 400. A missing or wrong key is 401.

I used SHA-256 and not bcrypt. bcrypt is slow on purpose to make guessing weak passwords expensive. A random 256-bit key cannot be guessed, and a plain hash lets me find the account with one indexed lookup on every request.

## The rules

A request for `N` units is accepted only if all four checks pass. The limits are inclusive.

1. `N <= user.max_per_request`
2. `N <= account.max_per_request`
3. `consumed_by_user + N <= user.monthly_allowance`
4. `consumed_by_account + N <= account.monthly_allowance`

A rejection changes nothing. When it is rejected, the response lists every rule that failed in `violations`. The first one in the order above is the headline (`rejected_by`, `rule`). That is why a company that used its whole allowance rejects every user with `rejected_by: "account"`, even a user who has used nothing.

Months are UTC calendar months. A new month is a new counter row, so usage restarts at zero without deleting anything, and older months stay queryable. `remaining` is `max(0, allowance - consumed)`, computed when it is read and never stored.

## API

Errors always look like `{ "error": { "code", "message", "details" } }`.

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness and decision counters |
| `POST /admin/accounts` | Create an account (admin key); returns its API key once |
| `GET /v1/account`, `PUT /v1/account/plan` | Read the account and its plan; assign an account plan |
| `GET /v1/plans`, `GET /v1/plans/:id`, `POST /v1/plans`, `PATCH /v1/plans/:id` | List, read, create and edit plans (only custom plans can be edited) |
| `POST /v1/users`, `GET /v1/users`, `GET /v1/users/:userId`, `PUT /v1/users/:userId/plan` | Register users, read them with their plan, assign a user plan |
| `POST /v1/consume` | Ask to consume units |
| `GET /v1/usage?user_id&period&limit&offset` | Consumed and remaining for the account and one user, or for every user |
| `GET /v1/history?user_id&period&decision&limit&cursor` | Accepted and rejected requests, newest first |

Status codes: `200` for any processed request (a consume that is rejected is also 200, with `accepted: false`), `201` created, `400` invalid input, `401` bad key, `403` editing a predefined plan, `404` not found or belongs to another account, `409` conflict (a reused `request_id` with different data, a duplicate user or plan name), `500` unexpected.

```bash
curl -s -X POST localhost:3000/admin/accounts -H "Authorization: Bearer dev-admin-key-change-me" \
     -H "content-type: application/json" -d '{"name":"DocFlow"}'
curl -s -X POST localhost:3000/v1/users -H "Authorization: Bearer $KEY" \
     -H "content-type: application/json" -d '{"user_id":"ahmad"}'
curl -s -X POST localhost:3000/v1/consume -H "Authorization: Bearer $KEY" \
     -H "content-type: application/json" -d '{"user_id":"ahmad","request_id":"req-1","units":15}'
```

```json
{ "accepted": true, "request_id": "req-1", "user_id": "ahmad", "units": 15, "period": "2026-10",
  "remaining": { "user": 985, "account": 9985 }, "replayed": false }
```

A 25 unit request from the same user is rejected, because a `Basic` user may use 20 per request:

```json
{ "accepted": false, "request_id": "req-2", "user_id": "ahmad", "units": 25, "period": "2026-10",
  "rejected_by": "user", "rule": "max_per_request",
  "violations": [ { "level": "user", "rule": "max_per_request", "limit": 20, "requested": 25 } ],
  "remaining": { "user": 985, "account": 9985 }, "replayed": false }
```

`GET /v1/usage?user_id=ahmad` returns the account and that user, each with its plan, allowance, `consumed` and `remaining`. Without `user_id` it returns a `users` array with every user of the account, a page at a time. `period=2026-09` shows an earlier month. `GET /v1/history` returns each request with its decision and a snapshot of the limits that applied (`snapshot.limits`, `consumed_before`, `remaining_after`). Pass the `next_cursor` of a page as `cursor` to get the next page.

## Plan changes

- A new assignment or an edit of a custom plan applies to the next request. The plans are read inside every consume transaction, so there is nothing to redeploy or refresh.
- Editing a custom plan changes every account or user that uses it, because they all point to the same plan row.
- Consumption is never reset. Counters store only what was consumed, never the limit. A user who used 90 and moves from a 100 plan to a 200 plan has 110 left, not 200.
- If an allowance is lowered below what was used, `remaining` is 0 and requests are rejected until the month changes or the allowance is raised.
- History is never rewritten: every log row keeps a JSON snapshot of the limits that decided it.
- A plan must be visible to the caller and have the right scope. Another account's custom plan is 404 and a wrong scope is 400. The database enforces the scope too.

## Retries

Networks fail: the service may record a request and the answer may get lost. Without protection a retry counts the units twice.

Every consume carries a `request_id` chosen by the client, unique per account. `UNIQUE (account_id, request_id)` allows one stored outcome per id. The same id with the same user and units returns the saved answer with `"replayed": true`, for rejections as well. The same id with a different user or units is a client bug and gets `409 request_id_conflict`. A new attempt, for example after a plan change, needs a new id.

## Architecture

```
http/          routes, Zod validation, auth hooks      (knows HTTP, calls services)
services/      one use case each, owns the transaction (calls repositories and the domain)
repositories/  all SQL, one file per table             (knows PostgreSQL)
domain/        rules, UTC months, decision events      (pure code, imports nothing from outside)
```

Dependencies point inward only: `http` to `services` to `repositories` and `domain`. The domain has no database or HTTP in it, so the rules are tested without either.

A consume request goes through these files:

1. `http/auth.ts` extracts the Bearer key and asks `services/accounts.ts` to find the account (401 if unknown).
2. `http/routes/meteringRoutes.ts` validates the body with `consumeBody` from `http/schemas.ts` (400 on bad input).
3. `services/consume.ts` opens one transaction for the steps below.
4. `repositories/consumption.ts`, `resolveUserAndEnsureCounters`: finds the user inside this account (404 otherwise) and makes sure the month's counter rows exist.
5. `lockCounters`: `SELECT ... FOR UPDATE` on the account row, then the user row.
6. `readContext`: loads an earlier answer for this `request_id` and the current plan limits.
7. `domain/rules.ts`, `evaluate`: the four checks. Then `recordDecision` updates both counters if accepted and inserts the log row, and `COMMIT` releases the locks.

### Patterns and principles, and what I chose instead

- **Strategy for the rules.** Each check is a `Rule` object and `evaluate()` runs the list in order. I could have written four `if` statements, which is shorter. I used objects so a new rule is added without editing `evaluate()` (open for extension, closed for change). A test adds one that way. It does not remove all work: a rule that needs new data, like a daily counter, still needs a column and a lock.
- **Observer for decisions.** After `COMMIT`, `consume` publishes an event. The listeners write a log line and keep the accepted, rejected and replayed counters shown in `/health`. I could have put the logging inside `consume`, but then the use case would know about logging and metrics. The event is published after the commit so a listener can never delay or break the transaction, and a failing listener is ignored.
- **Repository for the SQL.** All SQL is in `repositories/`, as plain functions. I did not use an ORM because the locking and transaction behavior is the interesting part of this service and I want it visible in the SQL.
- **Dependency injection, no global Singleton.** `buildApp({ pool, config, clock })` receives its dependencies. There is one shared `pg.Pool`, created once in `server.ts`, but it is passed in and not a global, so tests can pass a different clock or database. A Singleton would have been quicker to write and harder to test.
- **Transaction script for consume.** One function, one transaction, easy to read top to bottom. A domain object with behavior would be more elaborate than this little logic needs.
- **Single responsibility.** `rules.ts` only decides, repositories only talk to the database, routes only handle HTTP. Repositories take a `Db` (a pool or a transaction client), so the same function works in or outside a transaction.

## Concurrency

The danger: a user has 10 units left and two requests for 10 units arrive together. Both read "10 left", both pass, and 20 are consumed.

The fix is in the transaction. The account counter row and then the user counter row are locked with `SELECT ... FOR UPDATE`. A concurrent request that needs the same row waits and then sees the committed value. The lock order is always account first, then user, so two transactions cannot wait for each other in a circle. Requests of different accounts never wait for each other.

The `request_id` check runs after the locks, so two simultaneous retries cannot both pass it: the second waits and then finds the first one's committed row. The concurrency tests send dozens of simultaneous requests and check exact counts. They fail if the `FOR UPDATE` is removed, which I verified.

An alternative I considered is `UPDATE ... SET consumed = consumed + n WHERE consumed + n <= limit`, one atomic statement per counter. It is faster, but keeping the user and account updates all-or-nothing, and telling the caller which rule failed, needs more machinery. I preferred the version that is simple to reason about and measured whether it was fast enough.

## Database

PostgreSQL 16. The schema is in `service/migrations/`, numbered SQL files applied at start-up, each in its own transaction, recorded in `schema_migrations` and protected by an advisory lock so two instances starting together cannot race. Predefined plans are inserted with `ON CONFLICT DO NOTHING`, so a restart is safe.

| Table | Purpose |
|-------|---------|
| `plans` | Rule sets. `scope` is `account` or `user`. Predefined plans have no owner, custom ones belong to one account. |
| `accounts` | Applications: API key hash and prefix, and one account plan. |
| `users` | Users of an account (`external_user_id` is the caller's id, unique per account) with one user plan. |
| `usage_counters` | Units consumed per UTC month. `user_id IS NULL` is the account's counter. Consumed only, never limits. |
| `request_log` | Every consume request and its outcome, with a JSON snapshot of the limits used. |

What the database enforces itself, so a bug in the code cannot corrupt the data:

- Plan scope: a composite foreign key `(plan_id, plan_scope)` to `plans (id, scope)`, so an account cannot hold a user plan and a user cannot hold an account plan.
- Account isolation: composite foreign keys `(user_id, account_id)` to `users (id, account_id)` on counters and log, so usage can never be attached to another account's user.
- One counter per month: two partial unique indexes. A plain `UNIQUE` would not work, because the account counter has `NULL` in `user_id` and `NULL <> NULL`.
- Idempotency: `UNIQUE (account_id, request_id)`.
- Valid values: `CHECK` constraints for positive units, non-negative counters and allowances, first-of-month periods, and a rejected row must say why.

Choices I made, and what I considered instead:

- **Counter rows, not summing the log.** Reading usage is one row and the row is the lock target. Summing the log is simpler but gets slower with every request and has nothing to lock.
- **Counters store consumption only.** The limit is read from the plan at decision time, so a plan change takes effect immediately and can never wipe usage. Storing the limit in the counter would give a fresh allowance on each change and duplicate data.
- **Limits as columns, not a JSON `rules` column.** Only two rule types exist, so columns can be constrained and are clearer. JSON would be more flexible and unvalidated.
- **`TEXT` with `CHECK` for scope and decision, not enum types.** Adding a value later is an easy constraint change. Enums are awkward to alter.
- **Named constraints, and columns ordered by size** (8-byte columns first, then text) so PostgreSQL adds less padding.
- **`usage_counters` has `fillfactor = 70`.** It is the most updated table and the updated column is not indexed, so leaving room in each page lets PostgreSQL write the new row in the same page without touching the indexes (a HOT update). In the load test 99.7% of its updates were HOT.
- **Indexes follow the queries.** The history query always filters by account and sorts by `id`, so `request_log` has `(account_id, id DESC)`, plus `(account_id, period, id DESC)` and `(account_id, user_id, id DESC)` for the filters. Without the first one, PostgreSQL chose between walking the primary key and filtering by account, or using another index and sorting, depending on how the data was spread (I looked at the plans with `EXPLAIN` on 400,000 rows). With it, the query is always a short index scan that stops after `limit` rows. The cost is that every insert updates more indexes, which is included in the load test numbers below.
- **Keyset pagination for history** (`id < cursor`), not `OFFSET`. It stays fast on a big table and does not skip or repeat rows while new ones arrive. The users list uses `OFFSET` because an account has few users.
- **`BIGINT` columns are read as JS numbers.** The service refuses a value above 2^53 instead of silently rounding. Strings or `BigInt` everywhere would be exact but awkward in JSON.

`service/scripts/verify_schema.sql` tries to break these rules and prints the result (18 of 18).

## Time and memory

- Authentication: one lookup on a unique index, O(log n).
- Consume: a fixed number of statements (BEGIN, 4 statements, COMMIT), each using an index. The cost does not grow with the size of the history.
- Usage and history: bounded by `limit` (maximum 200 rows) and served from indexes.
- Memory: the service keeps no cache or list that grows with traffic. Counters are three integers. Request bodies are limited to 16 KB, the database pool is 10 connections, statements time out after 15 seconds, the Node heap is capped at 160 MB and the container at 256 MB. In the load test the service used 76 MB at the start and at most 104 MB after 21,000 requests, and it stayed flat.

## Tests

84 tests run against a real PostgreSQL, not mocks, because the database constraints are part of what is being tested: `cd service && npm test` or the `tests` profile.

- Rules: every limit at its boundary, check order, violations list, remaining never negative, UTC month boundaries, adding a rule without changing `evaluate()`.
- API keys: random, stored only as a hash; missing, wrong or malformed key gives 401; the admin key and account keys are not interchangeable; the key is checked before the body.
- Setup: accounts, plans (predefined read-only, custom, duplicates), users, plan assignment with scope checks, input validation.
- Consume: accepted, rejected by each of the four rules, account limit hit while the user still has allowance, rejections recorded, invalid units never recorded.
- Retries: an identical retry returns the saved answer and counts once, rejections replay, a reused id with different data gives 409, the same id in two accounts is two requests.
- Plan changes: next request uses the new plan, consumption kept, an edited plan affects all its users, allowance lowered below usage, a new month starts a new counter.
- Concurrency: simultaneous requests never exceed the user or account allowance, one `request_id` sent 25 times counts once, a mixed burst keeps counters equal to the sum of accepted requests.
- Account isolation: account B gets 404 for account A's users, plans, usage and history, cannot assign or edit A's plans, and cannot choose the account through the body. Direct SQL that crosses accounts or plan scopes is refused by the database.

## Load test

`loadtest/src/load.ts` is a plain Node script. It checks speed and correctness: after thousands of simultaneous requests every counter must equal the sum of the accepted requests and no limit may be exceeded.

```bash
docker compose up -d db service
docker compose --profile load run --rm loadtest            # about 2 minutes
SCALE=0.2 docker compose --profile load run --rm loadtest  # smaller run
cd loadtest && npm install && npm run dev                  # without Docker, service on :3000
```

Dependencies: Docker, or Node 22 and npm with a running service. Optional variables: `SERVICE_URL`, `ADMIN_API_KEY`, `SCALE`, `OUT`.

Results on a 2-core machine shared by the load generator, the service and PostgreSQL (full tables in [`loadtest/RESULTS.md`](loadtest/RESULTS.md)):

| Scenario | Req/s | p99 ms | Accepted / Rejected / Replayed | Correct |
|---|---:|---:|---|---|
| 0. baseline, one at a time | 170 | 14 | 500 / 0 / 0 | PASS |
| 1. 10 accounts, 20 users each | 561 | 161 | 10000 / 0 / 0 | PASS |
| 2. one hot account | 267 | 300 | 5000 / 0 / 0 | PASS |
| 3. allowance 1000, 5000 requests | 292 | 434 | 1000 / 4000 / 0 | PASS |
| 4. one `request_id` sent 300 times | 447 | 245 | 1 / 0 / 299 | PASS |

What I learned:

- Correctness held in every scenario: no errors, no deadlocks, no limit exceeded, counters exact.
- The first version used 11 statements per request and 20 connections. The hot account (scenario 2) reached 168 req/s with p99 539 ms.
- The bottleneck is the account counter's row lock, held until `COMMIT`. All requests of one account queue on it, and every statement run while holding it makes everybody wait longer.
- Merging statements (11 to 6 round trips, and 7 to 3 after the lock is taken) raised the hot account to 274 req/s and p99 to 259 ms in that run.
- A smaller pool helped the tail latency. With 20 connections, up to 20 sit blocked in the database on the same lock. With fewer the waiting happens in Node's queue, where it is cheap. In a shorter test p99 was 246 ms with 4 connections, 268 ms with 8 and 467 ms with 20. The default is 10.
- Different accounts never wait for each other, so capacity grows with the number of accounts. One very busy account is limited by how fast its own requests run one after another.
- The machine's two cores were saturated by three programs, so I stopped tuning. Numbers on other hardware will differ (about 10% between runs here), and the comparison before and after is the useful part.

## Supported rules and extending them

Two rule types exist, for account plans and for user plans: monthly allowance and maximum units per request, as the brief describes. I added no further rule types because the brief says a reliable core is worth more than unfinished extras.

A new rule, for example a daily limit, is a new `Rule` object placed in its position in `DEFAULT_RULES`, plus the data it needs (a column on `plans` and a counter). It behaves like the others: a request must satisfy all rules, any one can reject it, and every violated rule is reported. Because rules are pure functions, it can be tested without a database.

## Assumptions

- The brief does not say how accounts are created, so there is an admin endpoint protected by an environment key. Creating accounts is the operator's job.
- Users must be registered before use (`POST /v1/users`) so that each has a plan. An unknown user is 404 and is not created automatically.
- Units are positive integers. A monthly allowance may be 0, which means nothing can be consumed.
- A request belongs to the UTC month in which the server processes it, using the server clock.
- The account allowance is independent of its users' allowances. Users may have allowances that add up to more than the account has, and the account limit then protects the company.
- Predefined plans can be used by any account. A custom plan belongs to one account.
- A client retries the same operation with the same `request_id` and uses a new one for a new attempt.
- One service and one PostgreSQL, as in the brief. Correctness lives in the database transaction and not in process memory, so several instances would also work.

## Design decisions

| Decision | Why | What else I could have done |
|----------|-----|-----------------------------|
| A rejection is HTTP 200 with `accepted: false` | The request was handled correctly and "no" is a normal answer. It is also recorded and replayed. | `429` lets a client see a rejection from the status alone, but it is meant for rate limiting and mixes a business decision with transport errors. |
| `404` for another account's data | It does not reveal what exists in other accounts. | `403` is more explicit but leaks existence. |
| Idempotency in the database | It survives restarts and works across instances. | An in-memory cache is lost on restart and not shared. |
| `SELECT FOR UPDATE` | Simple to reason about and test. | The atomic conditional `UPDATE`, discussed above. |
| Migrations at start-up | `docker compose up` works with no manual step and two instances cannot race. | A separate migration job is cleaner for a large deployment. |
| Violations list in every rejection | The caller sees all reasons at once, in a fixed order. | Returning only the first reason is simpler but hides information. |
| Plain `pg`, Fastify, Zod | The locking is visible in the SQL and input rules live in one place. | An ORM hides the locking and makes the transaction harder to explain. |

## Limitations

- No key rotation or revocation. A lost key cannot be recovered because only the hash exists, so the operator creates a new account. A real product needs several keys per account with expiry.
- One admin key from an environment variable, no admin users, no audit of admin actions, no deleting or renaming accounts or users.
- No rate limiting and no TLS. TLS is expected to be handled in front of the service.
- One account's throughput is limited by its counter lock (about 270 requests per second on the test machine). Ideas if needed: the atomic `UPDATE` variant, splitting one account's counter over several rows, or batching.
- `request_log` and `usage_counters` grow forever. Partitioning the log by month is the natural next step, but it conflicts with `UNIQUE (account_id, request_id)` across months, so it needs a design change.
- A replayed answer is the original one, including `remaining` as it was then.
- Usage for a past month shows that month's consumption with the limits of today's plans.
- Plans cannot be deleted or change scope. Users cannot be removed or renamed.
- The load test numbers come from a small shared machine. They show behavior, not capacity, and should be repeated on the target hardware.
