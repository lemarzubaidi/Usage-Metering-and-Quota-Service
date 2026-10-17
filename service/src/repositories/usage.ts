import type { Db } from '../db/pool.js';

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
