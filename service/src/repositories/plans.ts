import type { Db } from '../db/pool.js';

// Repository = the only place that contains SQL for one table. It knows nothing about HTTP.

export type PlanScope = 'account' | 'user';

export interface Plan {
  id: number;
  name: string;
  scope: PlanScope;
  monthly_allowance: number;
  max_per_request: number;
  is_predefined: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

const PLAN_COLUMNS = `id, name, scope, monthly_allowance, max_per_request, is_predefined, created_at, updated_at`;

// A plan is "visible" to an account if it is predefined (owner IS NULL) or owned by that account.
// Another account's custom plan is simply not found -> the API answers 404, never revealing it exists.
export async function listVisible(db: Db, accountId: number): Promise<Plan[]> {
  const { rows } = await db.query<Plan>(
    `SELECT ${PLAN_COLUMNS} FROM plans
      WHERE owner_account_id IS NULL OR owner_account_id = $1
      ORDER BY is_predefined DESC, id`,
    [accountId],
  );
  return rows;
}

export async function findVisibleById(db: Db, planId: number, accountId: number): Promise<Plan | null> {
  const { rows } = await db.query<Plan>(
    `SELECT ${PLAN_COLUMNS} FROM plans
      WHERE id = $1 AND (owner_account_id IS NULL OR owner_account_id = $2)`,
    [planId, accountId],
  );
  return rows[0] ?? null;
}

export async function findPredefinedByName(db: Db, scope: PlanScope, name: string): Promise<Plan | null> {
  const { rows } = await db.query<Plan>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE owner_account_id IS NULL AND scope = $1 AND name = $2`,
    [scope, name],
  );
  return rows[0] ?? null;
}

export async function findPredefinedById(db: Db, planId: number): Promise<Plan | null> {
  const { rows } = await db.query<Plan>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1 AND owner_account_id IS NULL`,
    [planId],
  );
  return rows[0] ?? null;
}

export async function insertCustom(
  db: Db,
  accountId: number,
  p: { name: string; scope: PlanScope; monthly_allowance: number; max_per_request: number },
): Promise<Plan> {
  const { rows } = await db.query<Plan>(
    `INSERT INTO plans (name, scope, monthly_allowance, max_per_request, is_predefined, owner_account_id)
     VALUES ($1, $2, $3, $4, FALSE, $5)
     RETURNING ${PLAN_COLUMNS}`,
    [p.name, p.scope, p.monthly_allowance, p.max_per_request, accountId],
  );
  return rows[0]!;
}

// Only the account's OWN custom plans can be updated (owner_account_id = $1 excludes predefined plans).
// COALESCE keeps the old value for fields the caller did not send.
export async function updateCustom(
  db: Db,
  planId: number,
  accountId: number,
  p: { name?: string; monthly_allowance?: number; max_per_request?: number },
): Promise<Plan | null> {
  const { rows } = await db.query<Plan>(
    `UPDATE plans
        SET name              = COALESCE($3, name),
            monthly_allowance = COALESCE($4, monthly_allowance),
            max_per_request   = COALESCE($5, max_per_request),
            updated_at        = now()
      WHERE id = $1 AND owner_account_id = $2
      RETURNING ${PLAN_COLUMNS}`,
    [planId, accountId, p.name ?? null, p.monthly_allowance ?? null, p.max_per_request ?? null],
  );
  return rows[0] ?? null;
}

export interface PlanLimits {
  plan_id: number;
  plan_name: string;
  monthly_allowance: number;
  max_per_request: number;
}

// The limits that apply RIGHT NOW to one user and to its account (read inside the consume transaction,
// after the counters are locked, so a plan change committed a moment ago is already visible).
export async function limitsFor(
  db: Db,
  accountId: number,
  userId: number,
): Promise<{ user: PlanLimits; account: PlanLimits } | null> {
  const { rows } = await db.query<PlanLimits & { level: 'user' | 'account' }>(
    `SELECT 'user' AS level, p.id AS plan_id, p.name AS plan_name, p.monthly_allowance, p.max_per_request
       FROM users u JOIN plans p ON p.id = u.plan_id
      WHERE u.id = $2 AND u.account_id = $1
     UNION ALL
     SELECT 'account', p.id, p.name, p.monthly_allowance, p.max_per_request
       FROM accounts a JOIN plans p ON p.id = a.plan_id
      WHERE a.id = $1`,
    [accountId, userId],
  );
  const user = rows.find((r) => r.level === 'user');
  const account = rows.find((r) => r.level === 'account');
  return user && account ? { user, account } : null;
}
