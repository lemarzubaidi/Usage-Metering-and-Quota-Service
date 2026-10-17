import type pg from 'pg';
import { PG_UNIQUE_VIOLATION, conflict, forbidden, isPgError, notFound } from '../errors.js';
import * as plansRepo from '../repositories/plans.js';
import type { Plan, PlanScope } from '../repositories/plans.js';

export function listPlans(pool: pg.Pool, accountId: number): Promise<Plan[]> {
  return plansRepo.listVisible(pool, accountId);
}

export async function getPlan(pool: pg.Pool, accountId: number, planId: number): Promise<Plan> {
  const plan = await plansRepo.findVisibleById(pool, planId, accountId);
  if (!plan) throw notFound(`Plan ${planId} not found`);
  return plan;
}

export async function createCustomPlan(
  pool: pg.Pool,
  accountId: number,
  input: { name: string; scope: PlanScope; monthly_allowance: number; max_per_request: number },
): Promise<Plan> {
  try {
    return await plansRepo.insertCustom(pool, accountId, input);
  } catch (err) {
    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw conflict('plan_name_taken', `You already have a '${input.scope}' plan named '${input.name}'`);
    }
    throw err;
  }
}

export async function updateCustomPlan(
  pool: pg.Pool,
  accountId: number,
  planId: number,
  input: { name?: string; monthly_allowance?: number; max_per_request?: number },
): Promise<Plan> {
  const existing = await plansRepo.findVisibleById(pool, planId, accountId);
  if (!existing) throw notFound(`Plan ${planId} not found`);
  if (existing.is_predefined) throw forbidden('Predefined plans are read-only');
  try {
    const updated = await plansRepo.updateCustom(pool, planId, accountId, input);
    if (!updated) throw notFound(`Plan ${planId} not found`);
    return updated;
  } catch (err) {
    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw conflict('plan_name_taken', `You already have a '${existing.scope}' plan named '${input.name}'`);
    }
    throw err;
  }
}
