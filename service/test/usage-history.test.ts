import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consume, createAccount, createUser, createUserWithLimits, planIdByName, setAccountLimits, startTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let now = new Date('2026-10-15T12:00:00Z');
beforeAll(async () => { env = await startTestEnv({ clock: () => now }); });
afterAll(async () => { await env.close(); });

const get = async (acct: { auth: Record<string, string> }, url: string) => {
  const res = await env.app.inject({ method: 'GET', url, headers: acct.auth });
  return { status: res.statusCode, body: res.json() };
};

describe('GET /v1/usage', () => {
  it('shows account and user consumption with computed remaining', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'ahmad');
    await createUser(env.app, acct, 'sara');
    await consume(env.app, acct, { user_id: 'ahmad', request_id: '1', units: 20 });
    await consume(env.app, acct, { user_id: 'sara', request_id: '2', units: 5 });

    const r = await get(acct, '/v1/usage?user_id=ahmad');
    expect(r.status).toBe(200);
    expect(r.body.period).toBe('2026-10');
    expect(r.body.account).toMatchObject({ monthly_allowance: 10000, max_per_request: 100, consumed: 25, remaining: 9975, plan: { name: 'Starter' } });
    expect(r.body.user).toMatchObject({ user_id: 'ahmad', monthly_allowance: 1000, max_per_request: 20, consumed: 20, remaining: 980, plan: { name: 'Basic' } });
  });

  it('shows only the account when no user is given, and zero for a month with no usage', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    const r = await get(acct, '/v1/usage');
    expect(r.body.user).toBeUndefined();
    expect(r.body.account).toMatchObject({ consumed: 0, remaining: 10000 });
    const past = await get(acct, '/v1/usage?user_id=sara&period=2020-01');
    expect(past.body.user).toMatchObject({ consumed: 0 });
  });

  it('lists every user of the account (with their own plan) when no user_id is given, a page at a time', async () => {
    const acct = await createAccount(env.app);
    const other = await createAccount(env.app);
    await createUser(env.app, other, 'not-mine');
    await createUser(env.app, acct, 'ahmad');
    const premium = await planIdByName(env.app, acct, 'Premium');
    await createUser(env.app, acct, 'sara', premium);
    await createUser(env.app, acct, 'omar');
    await consume(env.app, acct, { user_id: 'ahmad', request_id: '1', units: 20 });
    await consume(env.app, acct, { user_id: 'sara', request_id: '2', units: 90 });

    const r = await get(acct, '/v1/usage');
    expect(r.body.account).toMatchObject({ consumed: 110, remaining: 9890 });
    expect(r.body.users.map((u: { user_id: string }) => u.user_id)).toEqual(['ahmad', 'sara', 'omar']);
    expect(r.body.users[0]).toMatchObject({ plan: { name: 'Basic' }, consumed: 20, remaining: 980 });
    expect(r.body.users[1]).toMatchObject({ plan: { name: 'Premium' }, consumed: 90, remaining: 9910 });
    expect(r.body.users[2]).toMatchObject({ consumed: 0, remaining: 1000 });

    const page = await get(acct, '/v1/usage?limit=1&offset=1');
    expect(page.body.users.map((u: { user_id: string }) => u.user_id)).toEqual(['sara']);
    const past = await get(acct, '/v1/usage?period=2020-01');
    expect(past.body.users.every((u: { consumed: number }) => u.consumed === 0)).toBe(true);
  });

  it('reflects a plan change immediately, without changing what was consumed', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    await consume(env.app, acct, { user_id: 'sara', request_id: '1', units: 20 });
    const premium = await planIdByName(env.app, acct, 'Premium');
    await env.app.inject({ method: 'PUT', url: '/v1/users/sara/plan', headers: acct.auth, payload: { plan_id: premium } });
    const r = await get(acct, '/v1/usage?user_id=sara');
    expect(r.body.user).toMatchObject({ plan: { name: 'Premium' }, monthly_allowance: 10000, consumed: 20, remaining: 9980 });
  });

  it('shows remaining 0, not a negative number, when an allowance is lowered below consumption', async () => {
    const acct = await createAccount(env.app);
    await setAccountLimits(env.app, acct, { monthly_allowance: 1000, max_per_request: 100 });
    await createUser(env.app, acct, 'sara');
    await consume(env.app, acct, { user_id: 'sara', request_id: '1', units: 20 });
    await setAccountLimits(env.app, acct, { monthly_allowance: 5, max_per_request: 100 });
    const r = await get(acct, '/v1/usage');
    expect(r.body.account).toMatchObject({ monthly_allowance: 5, consumed: 20, remaining: 0 });
  });

  it('validates input: bad period 400, unknown user 404', async () => {
    const acct = await createAccount(env.app);
    expect((await get(acct, '/v1/usage?period=2026-13')).status).toBe(400);
    expect((await get(acct, '/v1/usage?period=october')).status).toBe(400);
    expect((await get(acct, '/v1/usage?user_id=ghost')).status).toBe(404);
    expect((await get(acct, '/v1/usage?bogus=1')).status).toBe(400);
  });

  it('keeps each month separate', async () => {
    const acct = await createAccount(env.app);
    await createUserWithLimits(env.app, acct, 'u', { monthly_allowance: 100, max_per_request: 100 });
    now = new Date('2026-09-30T23:00:00Z');
    await consume(env.app, acct, { user_id: 'u', request_id: 'sep', units: 40 });
    now = new Date('2026-10-01T00:30:00Z');
    await consume(env.app, acct, { user_id: 'u', request_id: 'oct', units: 7 });
    expect((await get(acct, '/v1/usage?user_id=u&period=2026-09')).body.user.consumed).toBe(40);
    expect((await get(acct, '/v1/usage?user_id=u')).body.user.consumed).toBe(7);
    now = new Date('2026-10-15T12:00:00Z');
  });
});

describe('GET /v1/history', () => {
  it('lists accepted and rejected requests, newest first, with the reason and a snapshot', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    await consume(env.app, acct, { user_id: 'sara', request_id: 'one', units: 10 });
    await consume(env.app, acct, { user_id: 'sara', request_id: 'two', units: 50 });
    const r = await get(acct, '/v1/history');
    expect(r.status).toBe(200);
    expect(r.body.requests.map((x: { request_id: string }) => x.request_id)).toEqual(['two', 'one']);
    expect(r.body.requests[0]).toMatchObject({ accepted: false, rejected_by: 'user', rule: 'max_per_request', user_id: 'sara', units: 50, period: '2026-10' });
    expect(r.body.requests[1]).toMatchObject({ accepted: true, units: 10 });
    expect(r.body.requests[1].rejected_by).toBeUndefined();
    expect(r.body.requests[1].snapshot).toMatchObject({
      limits: { user: { plan_name: 'Basic', monthly_allowance: 1000, max_per_request: 20 }, account: { plan_name: 'Starter' } },
      consumed_before: { user: 0, account: 0 },
      remaining_after: { user: 990, account: 9990 },
    });
    expect(r.body.next_cursor).toBeNull();
  });

  it('does not rewrite history when a plan changes later', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    await consume(env.app, acct, { user_id: 'sara', request_id: 'old', units: 30 });
    const premium = await planIdByName(env.app, acct, 'Premium');
    await env.app.inject({ method: 'PUT', url: '/v1/users/sara/plan', headers: acct.auth, payload: { plan_id: premium } });
    await consume(env.app, acct, { user_id: 'sara', request_id: 'new', units: 30 });
    const r = await get(acct, '/v1/history');
    const byId = Object.fromEntries(r.body.requests.map((x: { request_id: string }) => [x.request_id, x]));
    expect(byId.old.accepted).toBe(false);
    expect(byId.old.snapshot.limits.user.plan_name).toBe('Basic');
    expect(byId.new.accepted).toBe(true);
    expect(byId.new.snapshot.limits.user.plan_name).toBe('Premium');
  });

  it('filters by user, period and decision', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'ahmad');
    await createUser(env.app, acct, 'sara');
    now = new Date('2026-09-10T10:00:00Z');
    await consume(env.app, acct, { user_id: 'ahmad', request_id: 'sep-a', units: 5 });
    now = new Date('2026-10-10T10:00:00Z');
    await consume(env.app, acct, { user_id: 'ahmad', request_id: 'oct-a', units: 5 });
    await consume(env.app, acct, { user_id: 'sara', request_id: 'oct-s', units: 5 });
    await consume(env.app, acct, { user_id: 'sara', request_id: 'oct-s-big', units: 500 });
    const ids = async (q: string) => (await get(acct, `/v1/history${q}`)).body.requests.map((x: { request_id: string }) => x.request_id);
    expect(await ids('?user_id=ahmad')).toEqual(['oct-a', 'sep-a']);
    expect(await ids('?period=2026-09')).toEqual(['sep-a']);
    expect(await ids('?period=2026-10&user_id=sara')).toEqual(['oct-s-big', 'oct-s']);
    expect(await ids('?decision=rejected')).toEqual(['oct-s-big']);
    now = new Date('2026-10-15T12:00:00Z');
  });

  it('paginates with a cursor without skipping or repeating rows', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    for (let i = 1; i <= 7; i++) await consume(env.app, acct, { user_id: 'sara', request_id: `r${i}`, units: 1 });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: { body: { requests: { request_id: string }[]; next_cursor: string | null } } = await get(acct, `/v1/history?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.body.requests.map((x) => x.request_id));
      cursor = r.body.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(['r7', 'r6', 'r5', 'r4', 'r3', 'r2', 'r1']);
  });

  it('validates input', async () => {
    const acct = await createAccount(env.app);
    expect((await get(acct, '/v1/history?limit=0')).status).toBe(400);
    expect((await get(acct, '/v1/history?limit=500')).status).toBe(400);
    expect((await get(acct, '/v1/history?cursor=abc')).status).toBe(400);
    expect((await get(acct, '/v1/history?decision=maybe')).status).toBe(400);
    expect((await get(acct, '/v1/history?period=nope')).status).toBe(400);
    expect((await get(acct, '/v1/history?user_id=ghost')).status).toBe(404);
  });
});
