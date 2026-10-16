import type { Db } from '../db/pool.js';
import { AppError, notFound } from '../errors.js';
import * as plansRepo from '../repositories/plans.js';
import type { Plan, PlanScope } from '../repositories/plans.js';

// Shared by "change the account's plan" and "change a user's plan" (and user creation).
//   - A plan that is not predefined and not owned by this account -> 404 (we never reveal other accounts' plans).
//   - A plan of the wrong scope (e.g. a user plan given to the account) -> 400.
// The database also refuses wrong scopes through the composite foreign key; this check just gives a clear message.
export async function resolveAssignablePlan(
  db: Db,
  accountId: number,
  planId: number,
  expectedScope: PlanScope,
): Promise<Plan> {
  const plan = await plansRepo.findVisibleById(db, planId, accountId);
  if (!plan) throw notFound(`Plan ${planId} not found`);
  if (plan.scope !== expectedScope) {
    throw new AppError(
      400,
      'plan_scope_mismatch',
      `Plan ${planId} is a '${plan.scope}' plan but a '${expectedScope}' plan is required here`,
    );
  }
  return plan;
}
