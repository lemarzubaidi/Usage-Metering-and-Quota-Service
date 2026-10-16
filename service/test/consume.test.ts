import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  createAccount,
  createUser,
  createUserWithLimits,
  planIdByName,
  setAccountLimits,
  startTestEnv,
  uniq,
  type TestAccount,
  type TestEnv,
} from './helpers.js';

let env: TestEnv;
let now = new Date('2026-10-15T12:00:00Z');
beforeAll(async () => { env = await startTestEnv({ clock: () => now }); });
afterAll(async () => { await env.close(); });

// What the database says an account / user has consumed this month (looked at directly, not through the API).
async function consumed(acct: TestAccount, userId?: string, period = '2026-10-01'): Promise<number> {
  const { rows } = userId
    ? await env.pool.query(
        `SELECT c.consumed FROM usage_counters c JOIN users u ON u.id = c.user_id
          WHERE c.account_id = $1 AND u.external_user_id = $2 AND c.period = $3`,
        [acct.id, userId, period],
      )
    : await env.pool.query(`SELECT consumed FROM usage_counters WHERE account_id = $1 AND user_id IS NULL AND period = $2`, [acct.id, period]);
  return rows[0] ? Number(rows[0].consumed) : 0;
}
const logCount = async (acct: TestAccount) =>
  Number((await env.pool.query('SELECT count(*) FROM request_log WHERE account_id = $1', [acct.id])).rows[0].count);

describe('accepting', () => {
  it('accepts a request, adds it to the user AND the account counter, and reports what is left', async () => {
    const acct = await createAccount(env.app); // Starter: 10000 / 100
    await createUser(env.app, acct, 'sara'); //   Basic:   1000 / 20
    const r = await consume(env.app, acct, { user_id: 'sara', request_id: 'r1', units: 15 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      accepted: true, request_id: 'r1', user_id: 'sara', units: 15, period: '2026-10',
      remaining: { user: 985, account: 9985 }, replayed: false,
    });
    expect(Object.keys(r.body)[0]).toBe('accepted');
    expect(await consumed(acct, 'sara')).toBe(15);
    expect(await consumed(acct)).toBe(15);
  });

  it('adds the same units to the account for different users (account total = sum of what its users consumed)', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'ahmad');
    await createUser(env.app, acct, 'sara');
    await consume(env.app, acct, { user_id: 'ahmad', request_id: 'a1', units: 10 });
    await consume(env.app, acct, { user_id: 'sara', request_id: 's1', units: 20 });
    expect(await consumed(acct, 'ahmad')).toBe(10);
    expect(await consumed(acct, 'sara')).toBe(20);
    expect(await consumed(acct)).toBe(30);
  });

  it('accepts exactly up to a limit and rejects the very next unit', async () => {
    const acct = await createAccount(env.app);
    await createUserWithLimits(env.app, acct, 'u', { monthly_allowance: 30, max_per_request: 10 });
    for (const id of ['a', 'b', 'c']) {
      expect((await consume(env.app, acct, { user_id: 'u', request_id: id, units: 10 })).body.accepted).toBe(true);
    }
    const over = await consume(env.app, acct, { user_id: 'u', request_id: 'd', units: 1 });
    expect(over.body).toMatchObject({ accepted: false, rejected_by: 'user', rule: 'monthly_allowance', remaining: { user: 0 } });
  });
});

describe('rejecting', () => {
  it('rejects by the user per-request limit and consumes nothing', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara'); // Basic max 20
    const r = await consume(env.app, acct, { user_id: 'sara', request_id: 'big', units: 21 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: false, rejected_by: 'user', rule: 'max_per_request' });
    expect(r.body.violations).toHaveLength(1);
    expect(r.body.violations[0]).toMatchObject({ level: 'user', rule: 'max_per_request', limit: 20, requested: 21 });
    expect(await consumed(acct, 'sara')).toBe(0);
    expect(await consumed(acct)).toBe(0);
  });

  it('rejects by the account per-request limit', async () => {
    const acct = await createAccount(env.app); // Starter max 100
    await createUserWithLimits(env.app, acct, 'u', { monthly_allowance: 5000, max_per_request: 500 });
    const r = await consume(env.app, acct, { user_id: 'u', request_id: 'x', units: 101 });
    expect(r.body).toMatchObject({ accepted: false, rejected_by: 'account', rule: 'max_per_request' });
  });

  it('rejects by the ACCOUNT monthly allowance although the user still has allowance left', async () => {
    const acct = await createAccount(env.app);
    await setAccountLimits(env.app, acct, { monthly_allowance: 25, max_per_request: 100 });
    await createUserWithLimits(env.app, acct, 'ahmad', { monthly_allowance: 1000, max_per_request: 100 });
    await createUserWithLimits(env.app, acct, 'sara', { monthly_allowance: 1000, max_per_request: 100 });
    expect((await consume(env.app, acct, { user_id: 'ahmad', request_id: 'a', units: 15 })).body.accepted).toBe(true);
    const r = await consume(env.app, acct, { user_id: 'sara', request_id: 's', units: 15 }); // sara used 0 of 1000, account has 10 left
    expect(r.body).toMatchObject({ accepted: false, rejected_by: 'account', rule: 'monthly_allowance', remaining: { user: 1000, account: 10 } });
    expect(r.body.violations[0]).toMatchObject({ level: 'account', limit: 25, consumed: 15, remaining: 10, requested: 15 });
    expect(await consumed(acct, 'sara')).toBe(0);
    expect(await consumed(acct)).toBe(15);
  });

  it('lists every violated rule and uses the first as the headline', async () => {
    const acct = await createAccount(env.app);
    await setAccountLimits(env.app, acct, { monthly_allowance: 10, max_per_request: 5 });
    await createUserWithLimits(env.app, acct, 'u', { monthly_allowance: 10, max_per_request: 5 });
    const r = await consume(env.app, acct, { user_id: 'u', request_id: 'x', units: 8 });
    expect(r.body.rejected_by).toBe('user');
    expect(r.body.rule).toBe('max_per_request');
    expect(r.body.violations.map((v: { level: string; rule: string }) => `${v.level}:${v.rule}`)).toEqual([
      'user:max_per_request', 'account:max_per_request',
    ]);
  });

  it('records rejected requests in the history too', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    await consume(env.app, acct, { user_id: 'sara', request_id: 'ok', units: 5 });
    await consume(env.app, acct, { user_id: 'sara', request_id: 'no', units: 500 });
    const { rows } = await env.pool.query('SELECT request_id, decision, rejected_by, rule FROM request_log WHERE account_id = $1 ORDER BY id', [acct.id]);
    expect(rows).toEqual([
      { request_id: 'ok', decision: 'accepted', rejected_by: null, rule: null },
      { request_id: 'no', decision: 'rejected', rejected_by: 'user', rule: 'max_per_request' },
    ]);
  });
});

describe('invalid input', () => {
  it('returns 400 (and records nothing) for bad units or bodies', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    const bad: unknown[] = [
      { user_id: 'sara', request_id: 'x', units: 0 },
      { user_id: 'sara', request_id: 'x', units: -5 },
      { user_id: 'sara', request_id: 'x', units: 2.5 },
      { user_id: 'sara', request_id: 'x', units: '5' },
      { user_id: 'sara', request_id: 'x', units: null },
      { user_id: 'sara', request_id: 'x', units: 1e30 },
      { user_id: 'sara', request_id: 'x' },
      { user_id: 'sara', units: 5 },
      { request_id: 'x', units: 5 },
      { user_id: 'sara', request_id: '  ', units: 5 },
      { user_id: 'sara', request_id: 'x', units: 5, extra: true },
    ];
    for (const body of bad) {
      const r = await consume(env.app, acct, body as never);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('invalid_request');
    }
    expect(await logCount(acct)).toBe(0);
    expect(await consumed(acct)).toBe(0);
  });

  it('returns 404 for a user that does not exist in this account', async () => {
    const acct = await createAccount(env.app);
    const r = await consume(env.app, acct, { user_id: 'ghost', request_id: 'x', units: 1 });
    expect(r.status).toBe(404);
    expect(await logCount(acct)).toBe(0);
  });
});

describe('idempotency (retries)', () => {
  it('answers an identical retry with the saved result and consumes only once', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    const first = await consume(env.app, acct, { user_id: 'sara', request_id: 'pay-1', units: 10 });
    const retry = await consume(env.app, acct, { user_id: 'sara', request_id: 'pay-1', units: 10 });
    expect(first.body.replayed).toBe(false);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ...first.body, replayed: true });
    expect(await consumed(acct, 'sara')).toBe(10);
    expect(await consumed(acct)).toBe(10);
    expect(await logCount(acct)).toBe(1);
  });

  it('replays a rejection too', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    const first = await consume(env.app, acct, { user_id: 'sara', request_id: 'r', units: 999 });
    const retry = await consume(env.app, acct, { user_id: 'sara', request_id: 'r', units: 999 });
    expect(first.body.accepted).toBe(false);
    expect(retry.body).toEqual({ ...first.body, replayed: true });
  });

  it('keeps answering a retry with the ORIGINAL result even after the plan changed', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    const first = await consume(env.app, acct, { user_id: 'sara', request_id: 'r', units: 30 }); // rejected: Basic max 20
    const premium = await planIdByName(env.app, acct, 'Premium');
    await env.app.inject({ method: 'PUT', url: '/v1/users/sara/plan', headers: acct.auth, payload: { plan_id: premium } });
    const retry = await consume(env.app, acct, { user_id: 'sara', request_id: 'r', units: 30 });
    expect(retry.body).toEqual({ ...first.body, replayed: true });
    const fresh = await consume(env.app, acct, { user_id: 'sara', request_id: 'r-new', units: 30 });
    expect(fresh.body.accepted).toBe(true);
  });

  it('returns 409 when a request_id is reused with different units or another user', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    await createUser(env.app, acct, 'omar');
    await consume(env.app, acct, { user_id: 'sara', request_id: 'r', units: 10 });
    const otherUnits = await consume(env.app, acct, { user_id: 'sara', request_id: 'r', units: 11 });
    expect(otherUnits.status).toBe(409);
    expect(otherUnits.body.error.code).toBe('request_id_conflict');
    const otherUser = await consume(env.app, acct, { user_id: 'omar', request_id: 'r', units: 10 });
    expect(otherUser.status).toBe(409);
    expect(await consumed(acct)).toBe(10);
  });

  it('treats the same request_id in two different accounts as two different requests', async () => {
    const a = await createAccount(env.app);
    const b = await createAccount(env.app);
    await createUser(env.app, a, 'sara');
    await createUser(env.app, b, 'sara');
    expect((await consume(env.app, a, { user_id: 'sara', request_id: 'same', units: 5 })).body.replayed).toBe(false);
    expect((await consume(env.app, b, { user_id: 'sara', request_id: 'same', units: 5 })).body.replayed).toBe(false);
    expect(await consumed(a)).toBe(5);
    expect(await consumed(b)).toBe(5);
  });
});

describe('plan changes and months', () => {
  it('applies a new plan to the NEXT request, keeps consumption, and never grants a fresh allowance', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara'); // Basic: 1000 / 20
    await consume(env.app, acct, { user_id: 'sara', request_id: '1', units: 20 });
    expect((await consume(env.app, acct, { user_id: 'sara', request_id: '2', units: 50 })).body.accepted).toBe(false); // > 20

    const premium = await planIdByName(env.app, acct, 'Premium'); // 10000 / 200
    await env.app.inject({ method: 'PUT', url: '/v1/users/sara/plan', headers: acct.auth, payload: { plan_id: premium } });

    const r = await consume(env.app, acct, { user_id: 'sara', request_id: '3', units: 50 });
    expect(r.body).toMatchObject({ accepted: true, remaining: { user: 10000 - 20 - 50 } }); // the 20 already used still counts
  });

  it('applies an edited custom plan to everyone assigned to it', async () => {
    const acct = await createAccount(env.app);
    const planId = await createUserWithLimits(env.app, acct, 'u1', { monthly_allowance: 100, max_per_request: 10 });
    await createUser(env.app, acct, 'u2', planId);
    expect((await consume(env.app, acct, { user_id: 'u1', request_id: 'a', units: 50 })).body.rule).toBe('max_per_request');
    expect((await consume(env.app, acct, { user_id: 'u2', request_id: 'b', units: 50 })).body.rule).toBe('max_per_request');
    await env.app.inject({ method: 'PATCH', url: `/v1/plans/${planId}`, headers: acct.auth, payload: { max_per_request: 60 } });
    expect((await consume(env.app, acct, { user_id: 'u1', request_id: 'c', units: 50 })).body.accepted).toBe(true);
    expect((await consume(env.app, acct, { user_id: 'u2', request_id: 'd', units: 50 })).body.accepted).toBe(true);
  });

  it('reports remaining 0 (not negative) when the allowance is lowered below what was consumed', async () => {
    const acct = await createAccount(env.app);
    const planId = await createUserWithLimits(env.app, acct, 'u', { monthly_allowance: 100, max_per_request: 100 });
    await consume(env.app, acct, { user_id: 'u', request_id: 'a', units: 90 });
    await env.app.inject({ method: 'PATCH', url: `/v1/plans/${planId}`, headers: acct.auth, payload: { monthly_allowance: 50 } });
    const r = await consume(env.app, acct, { user_id: 'u', request_id: 'b', units: 1 });
    expect(r.body).toMatchObject({ accepted: false, rejected_by: 'user', rule: 'monthly_allowance', remaining: { user: 0 } });
    expect(r.body.violations[0]).toMatchObject({ consumed: 90, remaining: 0, limit: 50 });
  });

  it('starts a fresh counter in a new UTC month and keeps the old one', async () => {
    const acct = await createAccount(env.app);
    await createUserWithLimits(env.app, acct, 'u', { monthly_allowance: 10, max_per_request: 10 });
    now = new Date('2026-10-31T23:59:59Z');
    expect((await consume(env.app, acct, { user_id: 'u', request_id: 'oct', units: 10 })).body.accepted).toBe(true);
    expect((await consume(env.app, acct, { user_id: 'u', request_id: 'oct2', units: 1 })).body.accepted).toBe(false);
    now = new Date('2026-11-01T00:00:01Z');
    const nov = await consume(env.app, acct, { user_id: 'u', request_id: 'nov', units: 10 });
    expect(nov.body).toMatchObject({ accepted: true, period: '2026-11' });
    expect(await consumed(acct, 'u', '2026-10-01')).toBe(10);
    expect(await consumed(acct, 'u', '2026-11-01')).toBe(10);
    now = new Date('2026-10-15T12:00:00Z');
  });
});

describe('concurrency (many requests at the same moment)', () => {
  it('never lets simultaneous requests exceed the USER allowance', async () => {
    const acct = await createAccount(env.app);
    await createUserWithLimits(env.app, acct, 'u', { monthly_allowance: 10, max_per_request: 5 });
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => consume(env.app, acct, { user_id: 'u', request_id: `c${i}`, units: 1 })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.accepted)).toHaveLength(10);
    expect(results.filter((r) => !r.body.accepted)).toHaveLength(30);
    expect(await consumed(acct, 'u')).toBe(10);
    expect(await consumed(acct)).toBe(10);
  });

  it('never lets simultaneous requests from DIFFERENT users exceed the ACCOUNT allowance', async () => {
    const acct = await createAccount(env.app);
    await setAccountLimits(env.app, acct, { monthly_allowance: 25, max_per_request: 10 });
    for (const u of ['u1', 'u2', 'u3', 'u4']) await createUserWithLimits(env.app, acct, u, { monthly_allowance: 100, max_per_request: 10 });
    const users = ['u1', 'u2', 'u3', 'u4'];
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => consume(env.app, acct, { user_id: users[i % 4]!, request_id: `c${i}`, units: 1 })),
    );
    expect(results.filter((r) => r.body.accepted)).toHaveLength(25);
    expect(await consumed(acct)).toBe(25);
    const perUser = await Promise.all(users.map((u) => consumed(acct, u)));
    expect(perUser.reduce((a, b) => a + b, 0)).toBe(25);
  });

  it('counts a request retried many times at once exactly once', async () => {
    const acct = await createAccount(env.app);
    await createUser(env.app, acct, 'sara');
    const results = await Promise.all(
      Array.from({ length: 25 }, () => consume(env.app, acct, { user_id: 'sara', request_id: 'same', units: 7 })),
    );
    expect(results.every((r) => r.status === 200 && r.body.accepted)).toBe(true);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    expect(await consumed(acct, 'sara')).toBe(7);
    expect(await consumed(acct)).toBe(7);
    expect(await logCount(acct)).toBe(1);
  });

  it('keeps counters equal to the sum of accepted requests under a mixed burst (no deadlocks, no 500s)', async () => {
    const acct = await createAccount(env.app);
    await setAccountLimits(env.app, acct, { monthly_allowance: 300, max_per_request: 10 });
    const users = ['a', 'b', 'c', 'd', 'e'];
    for (const u of users) await createUserWithLimits(env.app, acct, u, { monthly_allowance: 80, max_per_request: 10 });
    const results = await Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        consume(env.app, acct, { user_id: users[i % 5]!, request_id: uniq('m'), units: (i % 10) + 1 }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const acceptedUnits = results.filter((r) => r.body.accepted).reduce((s, r) => s + r.body.units, 0);
    expect(await consumed(acct)).toBe(acceptedUnits);
    expect(acceptedUnits).toBeLessThanOrEqual(300);
    for (const u of users) {
      const mine = results.filter((r) => r.body.user_id === u && r.body.accepted).reduce((s, r) => s + r.body.units, 0);
      expect(await consumed(acct, u)).toBe(mine);
      expect(mine).toBeLessThanOrEqual(80);
    }
  });
});
