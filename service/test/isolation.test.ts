import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consume, createAccount, createCustomPlan, createUser, startTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => { env = await startTestEnv(); });
afterAll(async () => { await env.close(); });

async function twoAccounts() {
  const a = await createAccount(env.app);
  const b = await createAccount(env.app);
  await createUser(env.app, a, 'only-a');
  await createUser(env.app, b, 'only-b');
  return { a, b };
}
const call = async (acct: { auth: Record<string, string> }, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => {
  const res = await env.app.inject({ method, url, headers: acct.auth, ...(payload ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.json() };
};

describe('users and consumption', () => {
  it('B cannot consume for, read, or change plan of a user of A', async () => {
    const { a, b } = await twoAccounts();
    expect((await consume(env.app, b, { user_id: 'only-a', request_id: 'x', units: 1 })).status).toBe(404);
    expect((await call(b, 'GET', '/v1/users/only-a')).status).toBe(404);
    expect((await call(b, 'GET', '/v1/usage?user_id=only-a')).status).toBe(404);
    expect((await call(b, 'GET', '/v1/history?user_id=only-a')).status).toBe(404);
    const premium = (await call(b, 'GET', '/v1/plans')).body.plans.find((p: { name: string }) => p.name === 'Premium').id;
    expect((await call(b, 'PUT', '/v1/users/only-a/plan', { plan_id: premium })).status).toBe(404);

    expect((await call(a, 'GET', '/v1/usage?user_id=only-a')).body.user.consumed).toBe(0);
    const { rows } = await env.pool.query('SELECT count(*) FROM request_log WHERE account_id = $1', [a.id]);
    expect(Number(rows[0].count)).toBe(0);
  });

  it('the account is decided by the API key only: a body field cannot select another account', async () => {
    const { a, b } = await twoAccounts();
    const res = await env.app.inject({
      method: 'POST', url: '/v1/consume', headers: b.auth,
      payload: { user_id: 'only-a', request_id: 'x', units: 1, account_id: a.id },
    });
    expect(res.statusCode).toBe(400);
    const res2 = await env.app.inject({ method: 'POST', url: '/v1/users', headers: b.auth, payload: { user_id: 'z', account_id: a.id } });
    expect(res2.statusCode).toBe(400);
  });

  it('usage and history of A and B never mix, even for the same user_id and request_id', async () => {
    const a = await createAccount(env.app);
    const b = await createAccount(env.app);
    await createUser(env.app, a, 'sara');
    await createUser(env.app, b, 'sara');
    await consume(env.app, a, { user_id: 'sara', request_id: 'same', units: 10 });
    await consume(env.app, b, { user_id: 'sara', request_id: 'same', units: 3 });

    expect((await call(a, 'GET', '/v1/usage?user_id=sara')).body).toMatchObject({ account: { consumed: 10 }, user: { consumed: 10 } });
    expect((await call(b, 'GET', '/v1/usage?user_id=sara')).body).toMatchObject({ account: { consumed: 3 }, user: { consumed: 3 } });
    const ha = (await call(a, 'GET', '/v1/history')).body.requests;
    const hb = (await call(b, 'GET', '/v1/history')).body.requests;
    expect(ha).toHaveLength(1);
    expect(hb).toHaveLength(1);
    expect(ha[0].units).toBe(10);
    expect(hb[0].units).toBe(3);
  });

  it('A using up its allowance does not affect B', async () => {
    const a = await createAccount(env.app);
    const b = await createAccount(env.app);
    await createUser(env.app, a, 'u');
    await createUser(env.app, b, 'u');
    for (let i = 0; i < 50; i++) await consume(env.app, a, { user_id: 'u', request_id: `r${i}`, units: 20 });
    expect((await consume(env.app, a, { user_id: 'u', request_id: 'more', units: 1 })).body.accepted).toBe(false);
    expect((await consume(env.app, b, { user_id: 'u', request_id: 'first', units: 20 })).body.accepted).toBe(true);
  });
});

describe('plans', () => {
  it("B cannot see, read, edit or assign A's custom plan, but both see the predefined plans", async () => {
    const { a, b } = await twoAccounts();
    const secret = await createCustomPlan(env.app, a, { name: 'A-secret', scope: 'user', monthly_allowance: 5, max_per_request: 1 });
    const accountSecret = await createCustomPlan(env.app, a, { name: 'A-account-secret', scope: 'account', monthly_allowance: 5, max_per_request: 1 });

    const listB = (await call(b, 'GET', '/v1/plans')).body.plans.map((p: { name: string }) => p.name);
    expect(listB).not.toContain('A-secret');
    expect(listB).toEqual(expect.arrayContaining(['Starter', 'Pro', 'Basic', 'Premium']));
    const listA = (await call(a, 'GET', '/v1/plans')).body.plans.map((p: { name: string }) => p.name);
    expect(listA).toContain('A-secret');

    expect((await call(b, 'GET', `/v1/plans/${secret}`)).status).toBe(404);
    expect((await call(b, 'PATCH', `/v1/plans/${secret}`, { monthly_allowance: 999 })).status).toBe(404);
    expect((await call(b, 'PUT', '/v1/users/only-b/plan', { plan_id: secret })).status).toBe(404);
    expect((await call(b, 'PUT', '/v1/account/plan', { plan_id: accountSecret })).status).toBe(404);
    expect((await call(b, 'POST', '/v1/users', { user_id: 'new', plan_id: secret })).status).toBe(404);

    expect((await call(a, 'GET', `/v1/plans/${secret}`)).body.plan.monthly_allowance).toBe(5);
  });

  it('editing A custom plan does not change anything for B', async () => {
    const a = await createAccount(env.app);
    const b = await createAccount(env.app);
    const planA = await createCustomPlan(env.app, a, { name: 'Team', scope: 'user', monthly_allowance: 10, max_per_request: 5 });
    const planB = await createCustomPlan(env.app, b, { name: 'Team', scope: 'user', monthly_allowance: 10, max_per_request: 5 });
    await call(a, 'PATCH', `/v1/plans/${planA}`, { monthly_allowance: 500 });
    expect((await call(b, 'GET', `/v1/plans/${planB}`)).body.plan.monthly_allowance).toBe(10);
  });
});

describe('the database itself refuses cross-account data (defense in depth)', () => {
  it("cannot attach a counter or a log row of A to a user of B, even with direct SQL", async () => {
    const { a, b } = await twoAccounts();
    const userB = (await env.pool.query(`SELECT id FROM users WHERE account_id = $1`, [b.id])).rows[0].id;
    await expect(
      env.pool.query(`INSERT INTO usage_counters (account_id, user_id, period) VALUES ($1, $2, '2026-10-01')`, [a.id, userB]),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      env.pool.query(
        `INSERT INTO request_log (account_id, user_id, request_id, units, decision, period) VALUES ($1, $2, 'x', 1, 'accepted', '2026-10-01')`,
        [a.id, userB],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('cannot give an account a user-scope plan or a user an account-scope plan, even with direct SQL', async () => {
    const { a } = await twoAccounts();
    const basic = (await env.pool.query(`SELECT id FROM plans WHERE name = 'Basic' AND is_predefined`)).rows[0].id;
    const starter = (await env.pool.query(`SELECT id FROM plans WHERE name = 'Starter' AND is_predefined`)).rows[0].id;
    await expect(env.pool.query(`UPDATE accounts SET plan_id = $1 WHERE id = $2`, [basic, a.id])).rejects.toThrow(/foreign key/i);
    await expect(env.pool.query(`UPDATE users SET plan_id = $1 WHERE account_id = $2`, [starter, a.id])).rejects.toThrow(/foreign key/i);
  });
});
