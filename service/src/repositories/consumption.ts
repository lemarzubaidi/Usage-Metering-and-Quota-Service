import type { Db } from '../db/pool.js';
import type { Level, RuleName } from '../domain/rules.js';

// The SQL of the consume "hot path". Each function is ONE round trip to the database, and the order
// below is the order they run in inside the transaction:
//
//   BEGIN
//   1. resolveUserAndEnsureCounters   (before any lock)
//   2. lockCounters                   <- from here until COMMIT we hold the account's lock
//   3. readContext
//   4. recordDecision
//   COMMIT
//
// Every round trip made while the lock is held makes every other request of the same account wait
// longer, so the work between the lock and COMMIT is kept to the minimum: 2 statements, then COMMIT.

export interface Limits {
  plan_id: number;
  plan_name: string;
  monthly_allowance: number;
  max_per_request: number;
}

// Snapshot stored with every decision. Later plan changes never rewrite it.
export interface LogDetails {
  limits: { user: Limits; account: Limits };
  consumed_before: { user: number; account: number };
  remaining_after: { user: number; account: number };
  violations: unknown[];
}

// An outcome that was already decided and saved (used to answer retries).
export interface StoredOutcome {
  user_id: number; // internal id
  external_user_id: string;
  request_id: string;
  units: number;
  decision: 'accepted' | 'rejected';
  rejected_by: Level | null;
  rule: RuleName | null;
  period: string; // 'YYYY-MM-01'
  details: LogDetails;
}

// 1. Find the user (only inside this account) and make sure this month's two counter rows exist.
//    The INSERT is a data-modifying CTE: PostgreSQL always runs it, even though the final SELECT does
//    not read it. "ON CONFLICT DO NOTHING" = if another request created the row a moment ago, fine.
//    Returns null when the user does not exist in this account.
export async function resolveUserAndEnsureCounters(
  db: Db,
  accountId: number,
  externalUserId: string,
  period: string,
): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `WITH u AS (
       SELECT id FROM users WHERE account_id = $1::bigint AND external_user_id = $2
     ), ensure AS (
       INSERT INTO usage_counters (account_id, user_id, period)
       SELECT $1::bigint, NULL::bigint, $3::date
       UNION ALL
       SELECT $1::bigint, u.id, $3::date FROM u
       ON CONFLICT DO NOTHING
     )
     SELECT id FROM u`,
    [accountId, externalUserId, period],
  );
  return rows[0]?.id ?? null;
}

// 2. Lock the account counter row and the user counter row, and read what they hold.
//    SELECT ... FOR UPDATE = "lock these rows until my transaction ends"; any other transaction that
//    wants them WAITS here and afterwards sees the committed values.
//    ORDER BY user_id NULLS FIRST: PostgreSQL sorts first and locks the rows in that order (see the
//    notes on ORDER BY with FOR UPDATE in the SELECT documentation), so the ACCOUNT row (user_id NULL)
//    is always locked before the user row. All transactions use the same order, so they can never wait
//    on each other in a circle (no deadlock).
export async function lockCounters(
  db: Db,
  accountId: number,
  userId: number,
  period: string,
): Promise<{ account: number; user: number }> {
  const { rows } = await db.query<{ user_id: number | null; consumed: number }>(
    `SELECT user_id, consumed
       FROM usage_counters
      WHERE account_id = $1 AND period = $2 AND (user_id IS NULL OR user_id = $3)
      ORDER BY user_id NULLS FIRST
        FOR UPDATE`,
    [accountId, period, userId],
  );
  const account = rows.find((r) => r.user_id === null);
  const user = rows.find((r) => r.user_id !== null);
  if (!account || !user) throw new Error('usage counters missing after ensure');
  return { account: account.consumed, user: user.consumed };
}

// 3. With the lock held, read in ONE query: (a) was this request_id already answered?  (b) which plans
//    apply to the user and to the account RIGHT NOW (so a plan change committed a moment ago is seen).
export async function readContext(
  db: Db,
  accountId: number,
  userId: number,
  requestId: string,
): Promise<{ existing: StoredOutcome | null; user: Limits; account: Limits }> {
  const { rows } = await db.query<{ existing: StoredOutcome | null; user_limits: Limits | null; account_limits: Limits | null }>(
    `SELECT
       (SELECT jsonb_build_object(
                 'user_id', l.user_id, 'external_user_id', u.external_user_id, 'request_id', l.request_id,
                 'units', l.units, 'decision', l.decision, 'rejected_by', l.rejected_by, 'rule', l.rule,
                 'period', l.period, 'details', l.details)
          FROM request_log l JOIN users u ON u.id = l.user_id
         WHERE l.account_id = $1 AND l.request_id = $3) AS existing,
       (SELECT jsonb_build_object('plan_id', p.id, 'plan_name', p.name,
                 'monthly_allowance', p.monthly_allowance, 'max_per_request', p.max_per_request)
          FROM users us JOIN plans p ON p.id = us.plan_id
         WHERE us.id = $2 AND us.account_id = $1) AS user_limits,
       (SELECT jsonb_build_object('plan_id', p.id, 'plan_name', p.name,
                 'monthly_allowance', p.monthly_allowance, 'max_per_request', p.max_per_request)
          FROM accounts a JOIN plans p ON p.id = a.plan_id
         WHERE a.id = $1) AS account_limits`,
    [accountId, userId, requestId],
  );
  const row = rows[0]!;
  if (!row.user_limits || !row.account_limits) throw new Error('user or account vanished during consume'); // cannot happen: FKs, no deletes
  return { existing: row.existing, user: row.user_limits, account: row.account_limits };
}

// 4. Save the decision, in ONE statement: add the units to BOTH counters (only when accepted) and
//    insert the request_log row. A statement is atomic, and the transaction makes the whole request atomic.
export async function recordDecision(
  db: Db,
  r: {
    accountId: number;
    userId: number;
    requestId: string;
    units: number;
    accepted: boolean;
    rejectedBy: Level | null;
    rule: RuleName | null;
    period: string;
    details: LogDetails;
  },
): Promise<void> {
  await db.query(
    `WITH bump AS (
       UPDATE usage_counters
          SET consumed = consumed + $4::bigint, updated_at = now()
        WHERE $5::boolean
          AND account_id = $1::bigint AND period = $3::date
          AND (user_id IS NULL OR user_id = $2::bigint)
       RETURNING id
     )
     INSERT INTO request_log (account_id, user_id, request_id, units, decision, rejected_by, rule, period, details)
     VALUES ($1::bigint, $2::bigint, $6, $4::bigint,
             CASE WHEN $5::boolean THEN 'accepted' ELSE 'rejected' END,
             $7::text, $8::text, $3::date, $9::jsonb)`,
    [r.accountId, r.userId, r.period, r.units, r.accepted, r.requestId, r.rejectedBy, r.rule, JSON.stringify(r.details)],
  );
}
