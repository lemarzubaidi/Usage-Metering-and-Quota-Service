import type pg from 'pg';
import { generateApiKey } from '../auth/apiKey.js';
import { AppError, notFound } from '../errors.js';
import * as accountsRepo from '../repositories/accounts.js';
import * as plansRepo from '../repositories/plans.js';
import { resolveAssignablePlan } from './planAssignment.js';

const DEFAULT_ACCOUNT_PLAN = 'Starter';

export async function createAccount(pool: pg.Pool, input: { name: string; plan_id?: number }) {
  let plan;
  if (input.plan_id === undefined) {
    plan = await plansRepo.findPredefinedByName(pool, 'account', DEFAULT_ACCOUNT_PLAN);
    if (!plan) throw new Error(`Predefined plan '${DEFAULT_ACCOUNT_PLAN}' is missing: were the migrations applied?`);
  } else {

    plan = await plansRepo.findPredefinedById(pool, input.plan_id);
    if (!plan) throw notFound(`Predefined plan ${input.plan_id} not found`);
    if (plan.scope !== 'account') {
      throw new AppError(400, 'plan_scope_mismatch', `Plan ${plan.id} is a 'user' plan; an account needs an 'account' plan`);
    }
  }
  const { key, hash, prefix } = generateApiKey();
  const id = await accountsRepo.insert(pool, { name: input.name, apiKeyHash: hash, apiKeyPrefix: prefix, planId: plan.id });
  const account = await accountsRepo.findById(pool, id);
  return { account: account!, apiKey: key };
}

export async function getAccount(pool: pg.Pool, accountId: number) {
  const account = await accountsRepo.findById(pool, accountId);
  if (!account) throw notFound('Account not found');
  return account;
}

export async function changeAccountPlan(pool: pg.Pool, accountId: number, planId: number) {
  const plan = await resolveAssignablePlan(pool, accountId, planId, 'account');
  await accountsRepo.setPlan(pool, accountId, plan.id);
  return getAccount(pool, accountId);
}
