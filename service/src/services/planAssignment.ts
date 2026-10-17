import type { Db } from '../db/pool.js';
import { AppError, notFound } from '../errors.js';
import * as plansRepo from '../repositories/plans.js';
import type { Plan, PlanScope } from '../repositories/plans.js';

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
