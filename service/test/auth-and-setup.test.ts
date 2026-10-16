import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from '../src/auth/apiKey.js';
import { ADMIN_KEY, bearer, createAccount, createCustomPlan, createUser, planIdByName, startTestEnv, uniq, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => { env = await startTestEnv(); });
afterAll(async () => { await env.close(); });

describe('API key handling', () => {
  it('generates a long random key and stores only its hash', async () => {
    const { key, hash, prefix } = generateApiKey();
    expect(key).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).not.toContain(key);
    expect(prefix).toBe(key.slice(0, 8));
  });

  it('never stores the plain key in the database', async () => {
    const acct = await createAccount(env.app);
    const { rows } = await env.pool.query('SELECT api_key_hash, api_key_prefix FROM accounts WHERE id = $1', [acct.id]);
    expect(rows[0].api_key_hash).toBe(hashApiKey(acct.key));
    expect(JSON.stringify(rows[0])).not.toContain(acct.key);
  });
});

describe('API key validation (401)', () => {
  it('rejects a request with no key', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/v1/account' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('rejects a wrong key', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/v1/account', headers: bearer('sk_not-a-real-key') });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/v1/account', headers: { authorization: 'Basic abc' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects the admin key on account endpoints and an account key on admin endpoints', async () => {
    const acct = await createAccount(env.app);
    expect((await env.app.inject({ method: 'GET', url: '/v1/account', headers: bearer(ADMIN_KEY) })).statusCode).toBe(401);
    const res = await env.app.inject({ method: 'POST', url: '/admin/accounts', headers: acct.auth, payload: { name: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('checks the key before looking at the body', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/v1/users', payload: { nonsense: true } });
    expect(res.statusCode).toBe(401);
  });

  it('leaves /health public', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /admin/accounts', () => {
  it('creates an account on the default Starter plan and returns the key once', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/admin/accounts', headers: bearer(ADMIN_KEY), payload: { name: uniq('acme') } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.api_key).toMatch(/^sk_/);
    expect(body.account.plan).toMatchObject({ name: 'Starter', scope: 'account', monthly_allowance: 10000, max_per_request: 100 });
    expect(JSON.stringify(body.account)).not.toContain(body.api_key);

    const me = await env.app.inject({ method: 'GET', url: '/v1/account', headers: bearer(body.api_key) });
    expect(me.statusCode).toBe(200);
    expect(me.json().account.id).toBe(body.account.id);
    expect(me.json()).not.toHaveProperty('api_key');
  });

  it('can start on another predefined account plan', async () => {
    const first = await createAccount(env.app);
    const pro = await planIdByName(env.app, first, 'Pro');
    const acct = await createAccount(env.app, { plan_id: pro });
    const me = await env.app.inject({ method: 'GET', url: '/v1/account', headers: acct.auth });
    expect(me.json().account.plan.name).toBe('Pro');
  });

  it('refuses a user-scope plan for an account (400) and an unknown plan (404)', async () => {
    const a = await createAccount(env.app);
    const basic = await planIdByName(env.app, a, 'Basic');
    const wrongScope = await env.app.inject({ method: 'POST', url: '/admin/accounts', headers: bearer(ADMIN_KEY), payload: { name: 'x', plan_id: basic } });
    expect(wrongScope.statusCode).toBe(400);
    expect(wrongScope.json().error.code).toBe('plan_scope_mismatch');
    const unknown = await env.app.inject({ method: 'POST', url: '/admin/accounts', headers: bearer(ADMIN_KEY), payload: { name: 'x', plan_id: 999999999 } });
    expect(unknown.statusCode).toBe(404);
  });

  it('validates the body (400)', async () => {
    const h = bearer(ADMIN_KEY);
    for (const payload of [{}, { name: '' }, { name: 123 }, { name: 'ok', extra: 1 }]) {
      const res = await env.app.inject({ method: 'POST', url: '/admin/accounts', headers: h, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    }
    const bad = await env.app.inject({ method: 'POST', url: '/admin/accounts', headers: { ...h, 'content-type': 'application/json' }, payload: '{not json' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('plans', () => {
  it('lists the four predefined plans to everyone', async () => {
    const acct = await createAccount(env.app);
    const res = await env.app.inject({ method: 'GET', url: '/v1/plans', headers: acct.auth });
    const predefined = res.json().plans.filter((p: { is_predefined: boolean }) => p.is_predefined);
    expect(predefined.map((p: { name: string }) => p.name).sort()).toEqual(['Basic', 'Premium', 'Pro', 'Starter']);
  });

  it('creates, reads and updates a custom plan', async () => {
    const acct = await createAccount(env.app);
    const id = await createCustomPlan(env.app, acct, { name: 'Interns', scope: 'user', monthly_allowance: 50, max_per_request: 5 });
    const upd = await env.app.inject({ method: 'PATCH', url: `/v1/plans/${id}`, headers: acct.auth, payload: { monthly_allowance: 80 } });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().plan).toMatchObject({ name: 'Interns', monthly_allowance: 80, max_per_request: 5 });
    const get = await env.app.inject({ method: 'GET', url: `/v1/plans/${id}`, headers: acct.auth });
    expect(get.json().plan.monthly_allowance).toBe(80);
  });

  it('makes predefined plans read-only (403)', async () => {
    const acct = await createAccount(env.app);
    const basic = await planIdByName(env.app, acct, 'Basic');
    const res = await env.app.inject({ method: 'PATCH', url: `/v1/plans/${basic}`, headers: acct.auth, payload: { monthly_allowance: 1 } });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a duplicate custom plan name in the same account (409) but allows it in another account', async () => {
    const a = await createAccount(env.app);
    const b = await createAccount(env.app);
    const body = { name: 'Team', scope: 'user', monthly_allowance: 10, max_per_request: 2 };
    expect((await env.app.inject({ method: 'POST', url: '/v1/plans', headers: a.auth, payload: body })).statusCode).toBe(201);
    const dup = await env.app.inject({ method: 'POST', url: '/v1/plans', headers: a.auth, payload: body });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('plan_name_taken');
    expect((await env.app.inject({ method: 'POST', url: '/v1/plans', headers: b.auth, payload: body })).statusCode).toBe(201);
  });

  it('validates plan input (400)', async () => {
    const acct = await createAccount(env.app);
    const bad = [
      { name: 'x', scope: 'user', monthly_allowance: -1, max_per_request: 5 },
      { name: 'x', scope: 'user', monthly_allowance: 10, max_per_request: 0 },
      { name: 'x', scope: 'user', monthly_allowance: 1.5, max_per_request: 1 },
      { name: 'x', scope: 'team', monthly_allowance: 10, max_per_request: 1 },
      { name: 'x', scope: 'user', monthly_allowance: '10', max_per_request: 1 },
    ];
    for (const payload of bad) {
      const res = await env.app.inject({ method: 'POST', url: '/v1/plans', headers: acct.auth, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const empty = await env.app.inject({ method: 'PATCH', url: '/v1/plans/1', headers: acct.auth, payload: {} });
    expect(empty.statusCode).toBe(400);
    const badId = await env.app.inject({ method: 'GET', url: '/v1/plans/abc', headers: acct.auth });
    expect(badId.statusCode).toBe(400);
  });
});

describe('users', () => {
  it('creates a user on the default Basic plan', async () => {
    const acct = await createAccount(env.app);
    const user = await createUser(env.app, acct, 'sara');
    expect(user).toMatchObject({ user_id: 'sara', plan: { name: 'Basic', scope: 'user' } });
    const get = await env.app.inject({ method: 'GET', url: '/v1/users/sara', headers: acct.auth });
    expect(get.statusCode).toBe(200);
  });

  it('refuses the same user_id twice in one account (409)', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    const dup = await env.app.inject({ method: 'POST', url: '/v1/users', headers: acct.auth, payload: { user_id: 'sara' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('user_exists');
  });

  it('allows the same user_id in two different accounts', async () => {
    const a = await createAccount(env.app);
    const b = await createAccount(env.app);
    await createUser(env.app, a, 'sara');
    await createUser(env.app, b, 'sara');
  });

  it('refuses an account-scope plan for a user (400)', async () => {
    const acct = await createAccount(env.app);
    const pro = await planIdByName(env.app, acct, 'Pro');
    const res = await env.app.inject({ method: 'POST', url: '/v1/users', headers: acct.auth, payload: { user_id: 'x', plan_id: pro } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('plan_scope_mismatch');
  });

  it('changes a user plan and an account plan', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    const premium = await planIdByName(env.app, acct, 'Premium');
    const up = await env.app.inject({ method: 'PUT', url: '/v1/users/sara/plan', headers: acct.auth, payload: { plan_id: premium } });
    expect(up.statusCode).toBe(200);
    expect(up.json().user.plan.name).toBe('Premium');

    const pro = await planIdByName(env.app, acct, 'Pro');
    const ap = await env.app.inject({ method: 'PUT', url: '/v1/account/plan', headers: acct.auth, payload: { plan_id: pro } });
    expect(ap.json().account.plan.name).toBe('Pro');
    const wrong = await env.app.inject({ method: 'PUT', url: '/v1/account/plan', headers: acct.auth, payload: { plan_id: premium } });
    expect(wrong.statusCode).toBe(400);
  });

  it('returns 404 for an unknown user and lists only this account\'s users', async () => {
    const a = await createAccount(env.app);
    const b = await createAccount(env.app);
    await createUser(env.app, a, 'only-in-a');
    await createUser(env.app, b, 'only-in-b');
    expect((await env.app.inject({ method: 'GET', url: '/v1/users/nobody', headers: a.auth })).statusCode).toBe(404);
    const list = await env.app.inject({ method: 'GET', url: '/v1/users', headers: a.auth });
    expect(list.json().users.map((u: { user_id: string }) => u.user_id)).toEqual(['only-in-a']);
  });
});
