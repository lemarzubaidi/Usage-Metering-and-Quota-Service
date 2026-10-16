import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { buildApp } from '../src/http/app.js';

export const ADMIN_KEY = 'test-admin-key';

export interface TestEnv {
  app: FastifyInstance;
  pool: pg.Pool;
  close: () => Promise<void>;
}

// Tests run against a REAL PostgreSQL (DATABASE_URL), not a mock: the database rules are part of what we test.
export async function startTestEnv(): Promise<TestEnv> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set DATABASE_URL to a PostgreSQL database to run the tests');
  const pool = createPool(databaseUrl);
  await runMigrations(pool);
  const config: Config = { databaseUrl, adminApiKey: ADMIN_KEY, port: 0, host: '127.0.0.1', logLevel: 'silent' };
  const app = buildApp({ pool, config });
  await app.ready();
  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
export const uniq = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex')}`;

export interface TestAccount {
  id: number;
  key: string;
  auth: { authorization: string };
}

export async function createAccount(app: FastifyInstance, opts: { name?: string; plan_id?: number } = {}): Promise<TestAccount> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/accounts',
    headers: bearer(ADMIN_KEY),
    payload: { name: opts.name ?? uniq('acct'), ...(opts.plan_id ? { plan_id: opts.plan_id } : {}) },
  });
  if (res.statusCode !== 201) throw new Error(`createAccount failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { id: body.account.id, key: body.api_key, auth: bearer(body.api_key) };
}

export async function planIdByName(app: FastifyInstance, acct: TestAccount, name: string): Promise<number> {
  const res = await app.inject({ method: 'GET', url: '/v1/plans', headers: acct.auth });
  const plan = res.json().plans.find((p: { name: string; is_predefined: boolean }) => p.name === name && p.is_predefined);
  if (!plan) throw new Error(`predefined plan ${name} not found`);
  return plan.id;
}

export async function createUser(app: FastifyInstance, acct: TestAccount, userId: string, planId?: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/users',
    headers: acct.auth,
    payload: { user_id: userId, ...(planId ? { plan_id: planId } : {}) },
  });
  if (res.statusCode !== 201) throw new Error(`createUser failed: ${res.statusCode} ${res.body}`);
  return res.json().user;
}

export async function createCustomPlan(
  app: FastifyInstance,
  acct: TestAccount,
  p: { name?: string; scope: 'account' | 'user'; monthly_allowance: number; max_per_request: number },
): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/plans',
    headers: acct.auth,
    payload: { name: p.name ?? uniq('plan'), ...p },
  });
  if (res.statusCode !== 201) throw new Error(`createCustomPlan failed: ${res.statusCode} ${res.body}`);
  return res.json().plan.id;
}
