import type { Db } from '../db/pool.js';
import type { Plan } from './plans.js';

export interface UserRow {
  id: number;
  account_id: number;
  external_user_id: string;
  plan_id: number;
  created_at: Date | string;
}

export interface UserWithPlan extends UserRow {
  plan: Plan;
}

const JOINED = `
  SELECT u.id, u.account_id, u.external_user_id, u.plan_id, u.created_at,
         json_build_object(
           'id', p.id, 'name', p.name, 'scope', p.scope,
           'monthly_allowance', p.monthly_allowance, 'max_per_request', p.max_per_request,
           'is_predefined', p.is_predefined, 'created_at', p.created_at, 'updated_at', p.updated_at
         ) AS plan
    FROM users u JOIN plans p ON p.id = u.plan_id`;

export async function insert(db: Db, accountId: number, externalUserId: string, planId: number): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO users (account_id, external_user_id, plan_id) VALUES ($1, $2, $3) RETURNING id`,
    [accountId, externalUserId, planId],
  );
  return rows[0]!.id;
}

// Every lookup includes account_id: a user is only ever found *through its own account*.
// This is the application-level half of account isolation (the DB composite FKs are the other half).
export async function findByExternalId(db: Db, accountId: number, externalUserId: string): Promise<UserWithPlan | null> {
  const { rows } = await db.query<UserWithPlan>(
    `${JOINED} WHERE u.account_id = $1 AND u.external_user_id = $2`,
    [accountId, externalUserId],
  );
  return rows[0] ?? null;
}

export async function list(db: Db, accountId: number, limit: number, offset: number): Promise<UserWithPlan[]> {
  const { rows } = await db.query<UserWithPlan>(
    `${JOINED} WHERE u.account_id = $1 ORDER BY u.id LIMIT $2 OFFSET $3`,
    [accountId, limit, offset],
  );
  return rows;
}

export async function setPlan(db: Db, userId: number, accountId: number, planId: number): Promise<void> {
  await db.query(`UPDATE users SET plan_id = $3 WHERE id = $1 AND account_id = $2`, [userId, accountId, planId]);
}

// Just the internal id (used by consume, which does not need the plan from this query).
export async function findIdByExternalId(db: Db, accountId: number, externalUserId: string): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM users WHERE account_id = $1 AND external_user_id = $2`,
    [accountId, externalUserId],
  );
  return rows[0]?.id ?? null;
}
