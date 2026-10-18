const BASE_URL = (process.env.SERVICE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? 'dev-admin-key-change-me';

interface Reply {
  status: number;
  body: any;
}

async function call(method: string, path: string, key: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function waitForService(): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`The service did not become ready at ${BASE_URL}`);
}

let failures = 0;
function check(description: string, ok: boolean): void {
  if (!ok) failures++;
  console.log(`      ${ok ? 'PASS' : 'FAIL'}  ${description}`);
}
const step = (title: string) => console.log(`\n=== ${title}`);

async function main(): Promise<void> {
  console.log(`Using the service at ${BASE_URL}`);
  await waitForService();

  step('Setup: create an account (the operator does this once; the API key is shown only now)');
  const created = await call('POST', '/admin/accounts', ADMIN_API_KEY, { name: `Demo app ${Date.now()}` });
  if (created.status !== 201) throw new Error(`Could not create the account: ${JSON.stringify(created.body)}`);
  const key: string = created.body.api_key;
  console.log(`      account #${created.body.account.id}, api key ${key.slice(0, 8)}... (never shown again)`);

  const accountPlan = await call('POST', '/v1/plans', key, { name: 'Demo account plan', scope: 'account', monthly_allowance: 60, max_per_request: 50 });
  const smallPlan = await call('POST', '/v1/plans', key, { name: 'Demo small user plan', scope: 'user', monthly_allowance: 40, max_per_request: 30 });
  const largePlan = await call('POST', '/v1/plans', key, { name: 'Demo large user plan', scope: 'user', monthly_allowance: 100, max_per_request: 50 });
  await call('PUT', '/v1/account/plan', key, { plan_id: accountPlan.body.plan.id });
  await call('POST', '/v1/users', key, { user_id: 'alice', plan_id: smallPlan.body.plan.id });
  await call('POST', '/v1/users', key, { user_id: 'bob', plan_id: largePlan.body.plan.id });
  console.log('      account plan:     60 units/month, max 50 per request  (shared by all users)');
  console.log('      alice, small plan: 40 units/month, max 30 per request');
  console.log('      bob,   large plan: 100 units/month, max 50 per request');

  const runId = Date.now();
  let counter = 0;
  async function consume(user: string, units: number, requestId = `demo-${runId}-${++counter}`) {
    const { status, body } = await call('POST', '/v1/consume', key, { user_id: user, request_id: requestId, units });
    const verdict = body.accepted
      ? 'ACCEPTED'
      : `REJECTED by ${body.rejected_by} (${body.rule})`;
    console.log(`   ${user} asks for ${units} units -> ${verdict}   remaining: user ${body.remaining?.user}, account ${body.remaining?.account}${body.replayed ? '  [replayed answer]' : ''}`);
    return { status, body, requestId };
  }

  step('1. A normal request is accepted');
  const first = await consume('alice', 30);
  check('alice 30 units accepted', first.body.accepted === true);

  step("2. alice asks for more than her own allowance (30 used + 15 > 40): rejected by the USER limit");
  const userLimit = await consume('alice', 15);
  check('rejected by user', userLimit.body.accepted === false && userLimit.body.rejected_by === 'user');
  check('rule is monthly_allowance', userLimit.body.rule === 'monthly_allowance');

  step('3. bob (large plan) uses the rest of the ACCOUNT allowance, then asks for more: rejected by the ACCOUNT limit');
  const bob1 = await consume('bob', 30);
  check('bob 30 units accepted (account now 60 of 60)', bob1.body.accepted === true);
  const accountLimit = await consume('bob', 10);
  check('rejected by the account although bob used only 30 of his 100', accountLimit.body.accepted === false && accountLimit.body.rejected_by === 'account');

  step('4. A network retry: the same request_id again is answered from the saved result, nothing is counted twice');
  const retry = await consume('alice', 30, first.requestId);
  check('same answer, marked as replayed', retry.body.accepted === true && retry.body.replayed === true);

  step('5. The account owner raises the account allowance from 60 to 200 (a plan change, no client change)');
  const change = await call('PATCH', `/v1/plans/${accountPlan.body.plan.id}`, key, { monthly_allowance: 200 });
  check('plan updated', change.status === 200 && change.body.plan.monthly_allowance === 200);

  step('6. The SAME call as in step 3 (bob, 10 units) is now accepted');
  const again = await consume('bob', 10);
  check('accepted after the plan change', again.body.accepted === true);

  step("7. alice is moved to the large plan: her earlier rejected call (15 units) is accepted now, her 30 used units still count");
  const switched = await call('PUT', '/v1/users/alice/plan', key, { plan_id: largePlan.body.plan.id });
  check('alice now has the large plan', switched.status === 200 && switched.body.user.plan.name === 'Demo large user plan');
  const aliceAgain = await consume('alice', 15);
  check('accepted after the user plan change', aliceAgain.body.accepted === true);
  check('alice remaining = 100 - 30 - 15 = 55 (no fresh allowance)', aliceAgain.body.remaining.user === 55);

  step('Usage this month (account and every user)');
  const usage = await call('GET', '/v1/usage', key);
  const a = usage.body.account;
  console.log(`   account  ${String(a.consumed).padStart(3)} of ${a.monthly_allowance} used, ${a.remaining} remaining   (plan: ${a.plan.name})`);
  for (const u of usage.body.users) {
    console.log(`   ${u.user_id.padEnd(8)} ${String(u.consumed).padStart(3)} of ${u.monthly_allowance} used, ${u.remaining} remaining   (plan: ${u.plan.name})`);
  }
  check('account consumed = alice 45 + bob 40 = 85', a.consumed === 85);
  check('account usage equals the sum of its users', a.consumed === usage.body.users.reduce((sum: number, u: any) => sum + u.consumed, 0));

  step('History (newest first)');
  const history = await call('GET', '/v1/history', key);
  for (const r of history.body.requests) {
    console.log(`   ${r.user_id.padEnd(6)} ${String(r.units).padStart(3)} units  ${r.accepted ? 'accepted' : `rejected by ${r.rejected_by} (${r.rule})`}`);
  }
  check('6 requests stored (the replayed retry is not stored a second time)', history.body.requests.length === 6);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
