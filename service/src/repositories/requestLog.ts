import type { Db } from '../db/pool.js';
import type { Level, RuleName } from '../domain/rules.js';

export interface LogRow {
  id: number;
  account_id: number;
  user_id: number; // internal id
  external_user_id: string; // the caller's id (joined from users)
  request_id: string;
  units: number;
  decision: 'accepted' | 'rejected';
  rejected_by: Level | null;
  rule: RuleName | null;
  period: string; // 'YYYY-MM-01'
  details: LogDetails;
  created_at: Date | string;
}

// Snapshot stored with every decision. Later plan changes never rewrite it.
export interface LogDetails {
  limits: {
    user: { plan_id: number; plan_name: string; monthly_allowance: number; max_per_request: number };
    account: { plan_id: number; plan_name: string; monthly_allowance: number; max_per_request: number };
  };
  consumed_before: { user: number; account: number };
  remaining_after: { user: number; account: number };
  violations: unknown[];
}

const SELECT_LOG = `
  SELECT l.id, l.account_id, l.user_id, u.external_user_id, l.request_id, l.units, l.decision,
         l.rejected_by, l.rule, l.period, l.details, l.created_at
    FROM request_log l JOIN users u ON u.id = l.user_id`;

export async function findByRequestId(db: Db, accountId: number, requestId: string): Promise<LogRow | null> {
  const { rows } = await db.query<LogRow>(`${SELECT_LOG} WHERE l.account_id = $1 AND l.request_id = $2`, [accountId, requestId]);
  return rows[0] ?? null;
}

export async function insert(
  db: Db,
  r: {
    accountId: number;
    userId: number;
    requestId: string;
    units: number;
    decision: 'accepted' | 'rejected';
    rejectedBy: Level | null;
    rule: RuleName | null;
    period: string;
    details: LogDetails;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO request_log (account_id, user_id, request_id, units, decision, rejected_by, rule, period, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [r.accountId, r.userId, r.requestId, r.units, r.decision, r.rejectedBy, r.rule, r.period, JSON.stringify(r.details)],
  );
}
