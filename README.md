# Usage Metering and Quota Service

A backend service (TypeScript + PostgreSQL) that other applications call to track usage and decide whether
their users may perform an action. An **account** (the calling application) has a shared monthly allowance,
and each **user** of that account has an individual allowance. Both plans apply to every request.

> **Status:** work in progress. Done so far: database schema + predefined plans (this document).
> Everything below the "Database schema" section is added as each part of the service is built.

## Core idea

A request to consume `N` units for a user is accepted only if **all four** checks pass:

| # | Rule | Owner |
|---|------|-------|
| 1 | `N <= max_per_request` | user plan |
| 2 | `N <= max_per_request` | account plan |
| 3 | `consumed_user + N <= monthly_allowance` | user plan |
| 4 | `consumed_account + N <= monthly_allowance` | account plan |

On acceptance the same `N` is added to the user counter and to the account counter. A rejection consumes nothing.
The account's allowance is its own number from its own plan; it is **not** the sum of its users' allowances.

## Database schema

PostgreSQL 16. Migrations live in `service/migrations/` and are applied in order at service start-up
(each one in its own transaction, tracked in `schema_migrations`, guarded by an advisory lock so two instances
starting together cannot race). Predefined plans are inserted with `ON CONFLICT DO NOTHING`, so restarting is safe.

```
plans <---- accounts <---- users
  ^             |             |
  |             v             v
  +-------- usage_counters (one row per account/user per UTC month)
                |
           request_log (one row per request: accepted or rejected)
```

| Table | Purpose |
|-------|---------|
| `plans` | Named rule sets (`monthly_allowance`, `max_per_request`). `scope` = `account` or `user`. Predefined plans have no owner and are read-only; custom plans belong to one account. |
| `accounts` | Calling applications. Stores only the SHA-256 **hash** of the API key plus a short prefix. Points to one account-scope plan. |
| `users` | Users registered under an account (`external_user_id` is the caller's own identifier). Points to one user-scope plan. |
| `usage_counters` | Units consumed per UTC month. `user_id IS NULL` means the account-level counter. Stores *consumed only*, never the limit. |
| `request_log` | Every consume request and its outcome, with a JSON snapshot of the limits that applied at the time. |

### Main design decisions

- **Counters store consumption only; limits are read from the plan at decision time.** Changing a plan therefore
  takes effect on the next request, keeps the units already consumed, and never grants a fresh allowance.
  If an allowance is lowered below the consumed amount, remaining is `max(0, allowance - consumed)`.
- **Counters instead of summing the log.** Reading one row is O(1); it is also the row that gets locked to keep
  concurrent requests correct.
- **Idempotency in the database:** `UNIQUE (account_id, request_id)` on `request_log`.
- **Isolation in the database:** composite foreign keys `(user_id, account_id) -> users(id, account_id)` make it
  impossible to record usage or history for a user under a different account. Plan scope is enforced the same way
  with `(plan_id, plan_scope) -> plans(id, scope)`.
- **`NULL` in unique keys:** the account-level counter has `user_id = NULL`, and PostgreSQL treats NULLs as distinct
  in plain `UNIQUE`, so two partial unique indexes are used instead.
- **History is immutable in meaning:** `request_log.details` is a JSONB snapshot (plan ids, limits, consumed-before,
  all violated rules), so later plan edits do not rewrite the past.
- **Integers:** `BIGINT` everywhere for units. The Node driver returns BIGINT as strings to avoid losing precision
  above 2^53, and conversions are explicit.
- **Plans are never deleted** (no DELETE endpoint); predefined plans are read-only.
- **Enforced in the service layer, not by a constraint:** "a custom plan may only be assigned inside its owner account"
  (it compares rows across tables).

### Predefined plans

| Plan | Scope | Monthly allowance | Max per request |
|------|-------|------------------:|----------------:|
| Starter | account | 10,000 | 100 |
| Pro | account | 100,000 | 1,000 |
| Basic | user | 1,000 | 20 |
| Premium | user | 10,000 | 200 |

## Running the schema (current state of the project)

The HTTP service does not exist yet, so `docker compose up --build` is **not** the way to run things at this stage.
Only the database and the migration runner can be run. Requirement: Docker Desktop.

```bash
# 1. start PostgreSQL only
docker compose up -d db

# 2. apply the migrations (builds the service image the first time)
docker compose run --rm service node dist/db/migrate.js

# 3. look at the result
docker compose exec db psql -U metering -d metering -c "\dt"
docker compose exec db psql -U metering -d metering -c "SELECT * FROM plans ORDER BY id"

# 4. prove that the database refuses wrong data (leaves no data behind)
docker compose exec -T db psql -U metering -d metering < service/scripts/verify_schema.sql

# stop everything (add -v to also delete the stored data)
docker compose down
```

Without Docker (needs Node 22 and a PostgreSQL you installed yourself):

```bash
cd service
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/metering npm run migrate
psql "$DATABASE_URL" -f scripts/verify_schema.sql
```

`service/scripts/verify_schema.sql` prints one `OK`/`FAIL` line per check (18 checks: plan scope, account isolation,
idempotency key, one counter per month, month-start period, rejection consistency, ...).
