import type { Db } from '../db/pool.js';

// usage_counters: one row per (account, month) with user_id NULL, and one per (user, month).
// A row stores ONLY how much was consumed. Limits are read from the plan when a decision is made.

// Makes sure both rows exist for this month. "ON CONFLICT DO NOTHING" = if another request just
// created the row, fine, do nothing (this is how we avoid a race on the first request of a month).
export async function ensureCounters(db: Db, accountId: number, userId: number, period: string): Promise<void> {
  await db.query(
    `INSERT INTO usage_counters (account_id, user_id, period)
     VALUES ($1, NULL, $3), ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [accountId, userId, period],
  );
}

// SELECT ... FOR UPDATE = "lock this row until my transaction ends". Any other transaction that wants
// to lock or update the same row WAITS here, and then sees the committed value. This is what stops two
// simultaneous requests from both reading "90 consumed" and both being accepted.
// Lock order is ALWAYS account row first, then user row, so two transactions can never wait on each other.
export async function lockAccountCounter(db: Db, accountId: number, period: string): Promise<number> {
  const { rows } = await db.query<{ consumed: number }>(
    `SELECT consumed FROM usage_counters
      WHERE account_id = $1 AND user_id IS NULL AND period = $2
      FOR UPDATE`,
    [accountId, period],
  );
  return rows[0]!.consumed;
}

export async function lockUserCounter(db: Db, userId: number, period: string): Promise<number> {
  const { rows } = await db.query<{ consumed: number }>(
    `SELECT consumed FROM usage_counters
      WHERE user_id = $1 AND period = $2
      FOR UPDATE`,
    [userId, period],
  );
  return rows[0]!.consumed;
}

export async function addToAccountCounter(db: Db, accountId: number, period: string, units: number): Promise<void> {
  await db.query(
    `UPDATE usage_counters SET consumed = consumed + $3, updated_at = now()
      WHERE account_id = $1 AND user_id IS NULL AND period = $2`,
    [accountId, period, units],
  );
}

export async function addToUserCounter(db: Db, userId: number, period: string, units: number): Promise<void> {
  await db.query(
    `UPDATE usage_counters SET consumed = consumed + $3, updated_at = now()
      WHERE user_id = $1 AND period = $2`,
    [userId, period, units],
  );
}

// Read-only (no lock): used by the usage endpoint. A missing row means nothing consumed yet.
export async function readAccountConsumed(db: Db, accountId: number, period: string): Promise<number> {
  const { rows } = await db.query<{ consumed: number }>(
    `SELECT consumed FROM usage_counters WHERE account_id = $1 AND user_id IS NULL AND period = $2`,
    [accountId, period],
  );
  return rows[0]?.consumed ?? 0;
}

export async function readUserConsumed(db: Db, userId: number, period: string): Promise<number> {
  const { rows } = await db.query<{ consumed: number }>(
    `SELECT consumed FROM usage_counters WHERE user_id = $1 AND period = $2`,
    [userId, period],
  );
  return rows[0]?.consumed ?? 0;
}

export interface UserUsageRow {
  external_user_id: string;
  consumed: number;
  plan: {
    id: number; name: string; scope: 'user'; monthly_allowance: number; max_per_request: number;
    is_predefined: boolean; created_at: string; updated_at: string;
  };
}

// Every user of the account with what it consumed in the month (0 if it has no counter yet) and the plan it has now.
export async function listUsersWithConsumption(
  db: Db,
  accountId: number,
  period: string,
  limit: number,
  offset: number,
): Promise<UserUsageRow[]> {
  const { rows } = await db.query<UserUsageRow>(
    `SELECT u.external_user_id, COALESCE(c.consumed, 0) AS consumed,
            json_build_object(
              'id', p.id, 'name', p.name, 'scope', p.scope,
              'monthly_allowance', p.monthly_allowance, 'max_per_request', p.max_per_request,
              'is_predefined', p.is_predefined, 'created_at', p.created_at, 'updated_at', p.updated_at
            ) AS plan
       FROM users u
       JOIN plans p ON p.id = u.plan_id
       LEFT JOIN usage_counters c ON c.user_id = u.id AND c.period = $2
      WHERE u.account_id = $1
      ORDER BY u.id
      LIMIT $3 OFFSET $4`,
    [accountId, period, limit, offset],
  );
  return rows;
}
