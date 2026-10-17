import type { AccountWithPlan } from '../repositories/accounts.js';
import type { Plan } from '../repositories/plans.js';
import type { UserWithPlan } from '../repositories/users.js';

export const planView = (p: Plan) => ({
  id: p.id,
  name: p.name,
  scope: p.scope,
  monthly_allowance: p.monthly_allowance,
  max_per_request: p.max_per_request,
  is_predefined: p.is_predefined,
});

export const accountView = (a: AccountWithPlan) => ({
  id: a.id,
  name: a.name,
  api_key_prefix: a.api_key_prefix,
  plan: planView(a.plan),
  created_at: a.created_at,
});

export const userView = (u: UserWithPlan) => ({
  user_id: u.external_user_id,
  plan: planView(u.plan),
  created_at: u.created_at,
});
