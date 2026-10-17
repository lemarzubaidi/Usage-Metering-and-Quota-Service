import type pg from 'pg';
import { PG_UNIQUE_VIOLATION, conflict, isPgError, notFound } from '../errors.js';
import * as plansRepo from '../repositories/plans.js';
import * as usersRepo from '../repositories/users.js';
import { resolveAssignablePlan } from './planAssignment.js';

const DEFAULT_USER_PLAN = 'Basic';

export async function createUser(pool: pg.Pool, accountId: number, input: { external_user_id: string; plan_id?: number }) {
  let planId: number;
  if (input.plan_id === undefined) {
    const def = await plansRepo.findPredefinedByName(pool, 'user', DEFAULT_USER_PLAN);
    if (!def) throw new Error(`Predefined plan '${DEFAULT_USER_PLAN}' is missing: were the migrations applied?`);
    planId = def.id;
  } else {
    planId = (await resolveAssignablePlan(pool, accountId, input.plan_id, 'user')).id;
  }
  try {
    await usersRepo.insert(pool, accountId, input.external_user_id, planId);
  } catch (err) {

    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw conflict('user_exists', `User '${input.external_user_id}' already exists in this account`);
    }
    throw err;
  }
  return getUser(pool, accountId, input.external_user_id);
}

export async function getUser(pool: pg.Pool, accountId: number, externalUserId: string) {
  const user = await usersRepo.findByExternalId(pool, accountId, externalUserId);
  if (!user) throw notFound(`User '${externalUserId}' not found`);
  return user;
}

export function listUsers(pool: pg.Pool, accountId: number, limit: number, offset: number) {
  return usersRepo.list(pool, accountId, limit, offset);
}

export async function changeUserPlan(pool: pg.Pool, accountId: number, externalUserId: string, planId: number) {
  const user = await getUser(pool, accountId, externalUserId);
  const plan = await resolveAssignablePlan(pool, accountId, planId, 'user');
  await usersRepo.setPlan(pool, user.id, accountId, plan.id);
  return getUser(pool, accountId, externalUserId);
}
