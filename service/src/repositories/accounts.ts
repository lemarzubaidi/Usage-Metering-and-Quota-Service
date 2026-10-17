import type { Db } from '../db/pool.js';
import type { Plan } from './plans.js';

export interface AccountRow {
  id: number;
  name: string;
  api_key_prefix: string;
  plan_id: number;
  created_at: Date | string;
}

export interface AccountWithPlan extends AccountRow {
  plan: Plan;
}

const JOINED = `
  SELECT a.id, a.name, a.api_key_prefix, a.plan_id, a.created_at,
         json_build_object(
           'id', p.id, 'name', p.name, 'scope', p.scope,
           'monthly_allowance', p.monthly_allowance, 'max_per_request', p.max_per_request,
           'is_predefined', p.is_predefined, 'created_at', p.created_at, 'updated_at', p.updated_at
         ) AS plan
    FROM accounts a JOIN plans p ON p.id = a.plan_id`;

export async function insert(
  db: Db,
  a: { name: string; apiKeyHash: string; apiKeyPrefix: string; planId: number },
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO accounts (name, api_key_hash, api_key_prefix, plan_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [a.name, a.apiKeyHash, a.apiKeyPrefix, a.planId],
  );
  return rows[0]!.id;
}

export async function findByKeyHash(db: Db, hash: string): Promise<AccountWithPlan | null> {
  const { rows } = await db.query<AccountWithPlan>(`${JOINED} WHERE a.api_key_hash = $1`, [hash]);
  return rows[0] ?? null;
}

export async function findById(db: Db, id: number): Promise<AccountWithPlan | null> {
  const { rows } = await db.query<AccountWithPlan>(`${JOINED} WHERE a.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function setPlan(db: Db, accountId: number, planId: number): Promise<void> {
  await db.query(`UPDATE accounts SET plan_id = $2 WHERE id = $1`, [accountId, planId]);
}
