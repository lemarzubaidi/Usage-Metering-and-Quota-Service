import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import * as accountsService from '../../services/accounts.js';
import * as plansService from '../../services/plans.js';
import * as usersService from '../../services/users.js';
import { createPlanBody, createUserBody, idParam, pageQuery, parse, setPlanBody, updatePlanBody } from '../schemas.js';
import { accountView, planView, userView } from '../view.js';

// Everything under /v1 except consume/usage/history (those are in meteringRoutes.ts).
export function accountRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  // ---- the calling account ----
  app.get('/v1/account', async (request) => ({ account: accountView(request.account) }));

  app.put('/v1/account/plan', async (request) => {
    const { plan_id } = parse(setPlanBody, request.body);
    const account = await accountsService.changeAccountPlan(pool, request.account.id, plan_id);
    return { account: accountView(account) };
  });

  // ---- plans ----
  app.get('/v1/plans', async (request) => {
    const plans = await plansService.listPlans(pool, request.account.id);
    return { plans: plans.map(planView) };
  });

  app.get<{ Params: { id: string } }>('/v1/plans/:id', async (request) => {
    const id = parse(idParam, request.params.id);
    return { plan: planView(await plansService.getPlan(pool, request.account.id, id)) };
  });

  app.post('/v1/plans', async (request, reply) => {
    const body = parse(createPlanBody, request.body);
    const plan = await plansService.createCustomPlan(pool, request.account.id, body);
    return reply.code(201).send({ plan: planView(plan) });
  });

  app.patch<{ Params: { id: string } }>('/v1/plans/:id', async (request) => {
    const id = parse(idParam, request.params.id);
    const body = parse(updatePlanBody, request.body);
    const plan = await plansService.updateCustomPlan(pool, request.account.id, id, body);
    return { plan: planView(plan) };
  });

  // ---- users ----
  app.post('/v1/users', async (request, reply) => {
    const body = parse(createUserBody, request.body);
    const user = await usersService.createUser(pool, request.account.id, { external_user_id: body.user_id, plan_id: body.plan_id });
    return reply.code(201).send({ user: userView(user) });
  });

  app.get('/v1/users', async (request) => {
    const { limit, offset } = parse(pageQuery, request.query);
    const users = await usersService.listUsers(pool, request.account.id, limit, offset);
    return { users: users.map(userView), limit, offset };
  });

  app.get<{ Params: { userId: string } }>('/v1/users/:userId', async (request) => {
    const user = await usersService.getUser(pool, request.account.id, request.params.userId);
    return { user: userView(user) };
  });

  app.put<{ Params: { userId: string } }>('/v1/users/:userId/plan', async (request) => {
    const { plan_id } = parse(setPlanBody, request.body);
    const user = await usersService.changeUserPlan(pool, request.account.id, request.params.userId, plan_id);
    return { user: userView(user) };
  });
}
