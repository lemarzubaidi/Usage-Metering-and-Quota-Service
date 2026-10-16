import type { AccountWithPlan } from '../repositories/accounts.js';
import type { Plan } from '../repositories/plans.js';
import type { UserWithPlan } from '../repositories/users.js';

// What leaves the service. Internal database ids of users are not exposed: the caller's own
// identifier (external_user_id) is the only user identifier in the API, called "user_id".

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
