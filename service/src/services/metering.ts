import type pg from 'pg';
import { parsePeriodLabel, periodLabel, periodStart } from '../domain/period.js';
import { remainingOf, type Limits } from '../domain/rules.js';
import { badRequest, notFound } from '../errors.js';
import * as accountsRepo from '../repositories/accounts.js';
import * as logRepo from '../repositories/requestLog.js';
import * as usageRepo from '../repositories/usage.js';
import * as usersRepo from '../repositories/users.js';
import { planView } from './view.js';

function resolvePeriod(label: string | undefined, clock: () => Date): string {
  if (label === undefined) return periodStart(clock());
  const period = parsePeriodLabel(label);
  if (!period) throw badRequest("period must look like '2026-10' (a UTC year and month)");
  return period;
}

const usageView = (limits: Limits, consumed: number) => ({
  monthly_allowance: limits.monthly_allowance,
  max_per_request: limits.max_per_request,
  consumed,
  remaining: remainingOf(limits, consumed),
});

export async function getUsage(
  pool: pg.Pool,
  clock: () => Date,
  accountId: number,
  q: { user_id?: string; period?: string; limit: number; offset: number },
) {
  const period = resolvePeriod(q.period, clock);
  const account = await accountsRepo.findById(pool, accountId);
  if (!account) throw notFound('Account not found');
  const accountConsumed = await usageRepo.readAccountConsumed(pool, accountId, period);

  const result: Record<string, unknown> = {
    period: periodLabel(period),
    account: { plan: planView(account.plan), ...usageView(account.plan, accountConsumed) },
  };
  if (q.user_id !== undefined) {
    const user = await usersRepo.findByExternalId(pool, accountId, q.user_id);
    if (!user) throw notFound(`User '${q.user_id}' not found`);
    const userConsumed = await usageRepo.readUserConsumed(pool, user.id, period);
    result.user = { user_id: user.external_user_id, plan: planView(user.plan), ...usageView(user.plan, userConsumed) };
  } else {
    const rows = await usageRepo.listUsersWithConsumption(pool, accountId, period, q.limit, q.offset);
    result.users = rows.map((r) => ({
      user_id: r.external_user_id,
      plan: planView(r.plan),
      ...usageView(r.plan, r.consumed),
    }));
    result.limit = q.limit;
    result.offset = q.offset;
  }
  return result;
}

export async function getHistory(
  pool: pg.Pool,
  clock: () => Date,
  accountId: number,
  q: { user_id?: string; period?: string; decision?: 'accepted' | 'rejected'; limit: number; cursor?: number },
) {
  let userId: number | undefined;
  if (q.user_id !== undefined) {
    const found = await usersRepo.findIdByExternalId(pool, accountId, q.user_id);
    if (found === null) throw notFound(`User '${q.user_id}' not found`);
    userId = found;
  }
  const period = q.period === undefined ? undefined : resolvePeriod(q.period, clock);

  const rows = await logRepo.list(pool, {
    accountId,
    userId,
    period,
    decision: q.decision,
    beforeId: q.cursor,
    limit: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  return {
    requests: page.map((r) => ({
      request_id: r.request_id,
      user_id: r.external_user_id,
      units: r.units,
      accepted: r.decision === 'accepted',
      ...(r.decision === 'rejected' ? { rejected_by: r.rejected_by, rule: r.rule, violations: r.details.violations } : {}),
      period: periodLabel(r.period),
      created_at: r.created_at,

      snapshot: { limits: r.details.limits, consumed_before: r.details.consumed_before, remaining_after: r.details.remaining_after },
    })),
    next_cursor: rows.length > q.limit ? String(page[page.length - 1]!.id) : null,
  };
}
