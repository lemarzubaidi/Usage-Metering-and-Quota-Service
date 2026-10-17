import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

const BASE_URL = (process.env.SERVICE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? 'dev-admin-key-change-me';
const SCALE = Number(process.env.SCALE ?? 1);
const OUT = process.env.OUT;
const scaled = (n: number) => Math.max(1, Math.round(n * SCALE));

interface Reply { status: number; body: any }
async function call(method: string, path: string, key: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function waitForService() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE_URL}/health`)).ok) return; } catch {  }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`service not reachable at ${BASE_URL}`);
}

interface Acct { id: number; key: string; users: string[] }
const runId = Date.now().toString(36);

async function newAccount(label: string, users: number, opts: { accountPlan?: [number, number]; userPlan?: [number, number] } = {}): Promise<Acct> {
  const created = await call('POST', '/admin/accounts', ADMIN_API_KEY, { name: `load-${label}-${runId}` });
  if (created.status !== 201) throw new Error(`create account failed: ${JSON.stringify(created.body)}`);
  const key: string = created.body.api_key;
  const plans = (await call('GET', '/v1/plans', key)).body.plans;
  const pro = plans.find((p: any) => p.name === 'Pro' && p.is_predefined).id;
  const premium = plans.find((p: any) => p.name === 'Premium' && p.is_predefined).id;
  let accountPlanId = pro;
  let userPlanId = premium;
  if (opts.accountPlan) {
    const p = await call('POST', '/v1/plans', key, { name: 'load-account', scope: 'account', monthly_allowance: opts.accountPlan[0], max_per_request: opts.accountPlan[1] });
    accountPlanId = p.body.plan.id;
  }
  if (opts.userPlan) {
    const p = await call('POST', '/v1/plans', key, { name: 'load-user', scope: 'user', monthly_allowance: opts.userPlan[0], max_per_request: opts.userPlan[1] });
    userPlanId = p.body.plan.id;
  }
  await call('PUT', '/v1/account/plan', key, { plan_id: accountPlanId });
  const names = Array.from({ length: users }, (_, i) => `user-${i}`);
  for (let i = 0; i < names.length; i += 20) {
    await Promise.all(names.slice(i, i + 20).map((u) => call('POST', '/v1/users', key, { user_id: u, plan_id: userPlanId })));
  }
  return { id: created.body.account.id, key, users: names };
}

interface Stats {
  total: number; durationS: number; rps: number;
  p50: number; p95: number; p99: number; max: number;
  httpErrors: number; accepted: number; rejected: number; replayed: number;
  acceptedUnitsByAccount: Map<number, number>;
}

async function drive(total: number, concurrency: number, send: (i: number) => Promise<{ reply?: Reply; acct: Acct; units: number }>): Promise<Stats> {
  const latencies: number[] = [];
  const acceptedUnitsByAccount = new Map<number, number>();
  let next = 0, httpErrors = 0, accepted = 0, rejected = 0, replayed = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const i = next++;
        if (i >= total) return;
        const t0 = performance.now();
        let out;
        try { out = await send(i); } catch { httpErrors++; continue; }
        latencies.push(performance.now() - t0);
        const r = out.reply!;
        if (r.status !== 200) { httpErrors++; continue; }
        if (r.body.replayed) replayed++;
        else if (r.body.accepted) {
          accepted++;
          acceptedUnitsByAccount.set(out.acct.id, (acceptedUnitsByAccount.get(out.acct.id) ?? 0) + out.units);
        } else rejected++;
      }
    }),
  );
  const durationS = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
  return { total, durationS, rps: total / durationS, p50: pct(50), p95: pct(95), p99: pct(99), max: latencies[latencies.length - 1] ?? 0, httpErrors, accepted, rejected, replayed, acceptedUnitsByAccount };
}

const rows: string[] = [];
const problems: string[] = [];
function report(name: string, concurrency: number, s: Stats, correct: boolean, note: string) {
  if (!correct) problems.push(name);
  rows.push(`| ${name} | ${s.total} | ${concurrency} | ${s.durationS.toFixed(1)} | ${s.rps.toFixed(0)} | ${s.p50.toFixed(0)} / ${s.p95.toFixed(0)} / ${s.p99.toFixed(0)} / ${s.max.toFixed(0)} | ${s.accepted} / ${s.rejected} / ${s.replayed} | ${s.httpErrors} | ${correct ? 'PASS' : '**FAIL**'} |`);
  console.log(`  ${name}: ${s.rps.toFixed(0)} req/s, p95 ${s.p95.toFixed(0)} ms, ${s.httpErrors} errors, correctness ${correct ? 'PASS' : 'FAIL'}${note ? ` (${note})` : ''}`);
}

const consumedOf = async (a: Acct) => (await call('GET', '/v1/usage', a.key)).body.account.consumed as number;
const consumedOfUser = async (a: Acct, u: string) => (await call('GET', `/v1/usage?user_id=${u}`, a.key)).body.user.consumed as number;

async function main() {
  await waitForService();
  console.log(`Load test against ${BASE_URL} (SCALE=${SCALE})`);
  const reqId = (() => { let n = 0; return () => `L-${runId}-${++n}`; })();

  console.log('\n0. Baseline: one request at a time (no waiting for anyone)');
  {
    const a = await newAccount('baseline', 1);
    const s = await drive(scaled(500), 1, async (i) => {
      const units = 1 + (i % 5);
      return { reply: await call('POST', '/v1/consume', a.key, { user_id: a.users[0], request_id: reqId(), units }), acct: a, units };
    });
    const ok = s.rejected === 0 && s.httpErrors === 0 && (await consumedOf(a)) === (s.acceptedUnitsByAccount.get(a.id) ?? 0);
    report('0. baseline, 1 at a time', 1, s, ok, 'latency with no contention');
  }

  console.log('\n1. Many accounts, no limit reached');
  {
    const accts = await Promise.all(Array.from({ length: 10 }, (_, i) => newAccount(`many${i}`, 20)));
    const concurrency = 50;
    const s = await drive(scaled(10000), concurrency, async (i) => {
      const a = accts[i % accts.length]!;
      const units = 1 + (i % 5);
      return { reply: await call('POST', '/v1/consume', a.key, { user_id: a.users[i % a.users.length], request_id: reqId(), units }), acct: a, units };
    });
    let ok = s.rejected === 0 && s.httpErrors === 0;
    for (const a of accts) ok = ok && (await consumedOf(a)) === (s.acceptedUnitsByAccount.get(a.id) ?? 0);
    report('1. 10 accounts, 20 users each', concurrency, s, ok, 'every account counter = sum of its accepted units');
  }

  console.log('\n2. One hot account (all requests lock the same account counter)');
  {
    const a = await newAccount('hot', 20);
    const concurrency = 50;
    const s = await drive(scaled(5000), concurrency, async (i) => {
      const units = 1 + (i % 5);
      return { reply: await call('POST', '/v1/consume', a.key, { user_id: a.users[i % a.users.length], request_id: reqId(), units }), acct: a, units };
    });
    const ok = s.rejected === 0 && s.httpErrors === 0 && (await consumedOf(a)) === (s.acceptedUnitsByAccount.get(a.id) ?? 0);
    report('2. 1 account, 20 users', concurrency, s, ok, 'serialised by the account row lock');
  }

  console.log('\n3. Allowance of 1000 units hit by far more requests than fit');
  {
    const a = await newAccount('limit', 10, { accountPlan: [1000, 10], userPlan: [1000, 10] });
    const concurrency = 100;
    const s = await drive(scaled(5000), concurrency, async (i) => {
      return { reply: await call('POST', '/v1/consume', a.key, { user_id: a.users[i % a.users.length], request_id: reqId(), units: 1 }), acct: a, units: 1 };
    });
    const consumed = await consumedOf(a);
    let perUser = 0;
    for (const u of a.users) perUser += await consumedOfUser(a, u);
    const expectedAccepted = Math.min(1000, scaled(5000));
    const ok = consumed === expectedAccepted && s.accepted === expectedAccepted && perUser === consumed && s.httpErrors === 0;
    report('3. allowance 1000, many requests', concurrency, s, ok, `consumed ${consumed} (limit 1000), accepted ${s.accepted}`);
  }

  console.log('\n4. Same request_id sent 300 times at once');
  {
    const a = await newAccount('retry', 1);
    const sameId = reqId();
    const concurrency = 100;
    const s = await drive(300, concurrency, async () => ({
      reply: await call('POST', '/v1/consume', a.key, { user_id: a.users[0], request_id: sameId, units: 7 }), acct: a, units: 7,
    }));
    const ok = s.accepted === 1 && s.replayed === 299 && (await consumedOf(a)) === 7 && s.httpErrors === 0;
    report('4. one request_id x300', concurrency, s, ok, 'consumed exactly once');
  }

  const header = [
    '| Scenario | Requests | Concurrency | Seconds | Req/s | Latency ms p50 / p95 / p99 / max | Accepted / Rejected / Replayed | HTTP errors | Correct |',
    '|---|---:|---:|---:|---:|---|---|---:|---|',
  ];
  const md = [
    `Date: ${new Date().toISOString()}  |  Node ${process.version}  |  ${cpus().length} CPU cores (load generator and service share this machine)`,
    '',
    ...header,
    ...rows,
    '',
    problems.length === 0 ? 'All correctness checks passed.' : `FAILED: ${problems.join('; ')}`,
  ].join('\n');
  console.log(`\n${md}`);
  if (OUT) writeFileSync(OUT, `${md}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
