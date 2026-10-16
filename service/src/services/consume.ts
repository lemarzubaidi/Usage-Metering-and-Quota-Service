import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { periodLabel, periodStart } from '../domain/period.js';
import { evaluate, remainingOf, type Level, type RuleName } from '../domain/rules.js';
import { conflict, notFound } from '../errors.js';
import * as plansRepo from '../repositories/plans.js';
import * as logRepo from '../repositories/requestLog.js';
import type { LogDetails, LogRow } from '../repositories/requestLog.js';
import * as usageRepo from '../repositories/usage.js';
import * as usersRepo from '../repositories/users.js';

export interface ConsumeInput {
  user_id: string; // the caller's own id for the user
  request_id: string;
  units: number;
}

// What the API returns. `accepted` is the first field on purpose: it is the answer.
export interface ConsumeResult {
  accepted: boolean;
  request_id: string;
  user_id: string;
  units: number;
  period: string; // 'YYYY-MM' (UTC month)
  rejected_by?: Level;
  rule?: RuleName;
  violations?: unknown[];
  remaining: { user: number; account: number }; // after this request (unchanged when rejected)
  replayed: boolean; // true = this is the saved answer to an earlier identical request, nothing was consumed again
}

// The whole consume operation = ONE database transaction:
//   1. find the user (inside the caller's own account only)
//   2. make sure this month's counters exist
//   3. LOCK the account counter, then the user counter      <- concurrent requests queue up here
//   4. idempotency: has this request_id already been answered?  (checked after the lock: see below)
//   5. read the plans that apply right now
//   6. evaluate the four rules
//   7. if accepted: add the units to both counters
//   8. write the request_log row (accepted AND rejected requests are recorded)
//   9. COMMIT (releases the locks)
// Either all of it happens or none of it does.
export async function consume(
  pool: pg.Pool,
  clock: () => Date,
  accountId: number,
  input: ConsumeInput,
): Promise<ConsumeResult> {
  const period = periodStart(clock());

  return withTransaction(pool, async (tx) => {
    const userId = await usersRepo.findIdByExternalId(tx, accountId, input.user_id);
    if (userId === null) throw notFound(`User '${input.user_id}' not found`);

    await usageRepo.ensureCounters(tx, accountId, userId, period);
    const consumedAccount = await usageRepo.lockAccountCounter(tx, accountId, period);
    const consumedUser = await usageRepo.lockUserCounter(tx, userId, period);

    // Idempotency check comes AFTER taking the lock. Every request of an account first locks the
    // account counter, so two requests with the same request_id cannot be here at the same time: the
    // second one waits, and when it gets the lock the first one's log row is already committed and visible.
    const existing = await logRepo.findByRequestId(tx, accountId, input.request_id);
    if (existing) {
      if (existing.user_id !== userId || existing.units !== input.units) {
        throw conflict(
          'request_id_conflict',
          `request_id '${input.request_id}' was already used with different data (user or units)`,
        );
      }
      return fromLog(existing, true);
    }

    const limits = await plansRepo.limitsFor(tx, accountId, userId);
    if (!limits) throw new Error('user or account vanished during consume'); // cannot happen: FKs, no deletes

    const decision = evaluate({
      units: input.units,
      user: limits.user,
      account: limits.account,
      consumedUser,
      consumedAccount,
    });

    if (decision.accepted) {
      await usageRepo.addToAccountCounter(tx, accountId, period, input.units);
      await usageRepo.addToUserCounter(tx, userId, period, input.units);
    }
    const afterUser = consumedUser + (decision.accepted ? input.units : 0);
    const afterAccount = consumedAccount + (decision.accepted ? input.units : 0);

    const details: LogDetails = {
      limits: {
        user: toSnapshot(limits.user),
        account: toSnapshot(limits.account),
      },
      consumed_before: { user: consumedUser, account: consumedAccount },
      remaining_after: { user: remainingOf(limits.user, afterUser), account: remainingOf(limits.account, afterAccount) },
      violations: decision.accepted ? [] : decision.violations,
    };

    await logRepo.insert(tx, {
      accountId,
      userId,
      requestId: input.request_id,
      units: input.units,
      decision: decision.accepted ? 'accepted' : 'rejected',
      rejectedBy: decision.accepted ? null : decision.rejected_by,
      rule: decision.accepted ? null : decision.rule,
      period,
      details,
    });

    return {
      accepted: decision.accepted,
      request_id: input.request_id,
      user_id: input.user_id,
      units: input.units,
      period: periodLabel(period),
      ...(decision.accepted ? {} : { rejected_by: decision.rejected_by, rule: decision.rule, violations: decision.violations }),
      remaining: details.remaining_after,
      replayed: false,
    };
  });
}

const toSnapshot = (l: plansRepo.PlanLimits) => ({
  plan_id: l.plan_id,
  plan_name: l.plan_name,
  monthly_allowance: l.monthly_allowance,
  max_per_request: l.max_per_request,
});

// Rebuilds the saved answer from the log row (used for idempotent replays).
export function fromLog(row: LogRow, replayed: boolean): ConsumeResult {
  const accepted = row.decision === 'accepted';
  return {
    accepted,
    request_id: row.request_id,
    user_id: row.external_user_id,
    units: row.units,
    period: periodLabel(row.period),
    ...(accepted ? {} : { rejected_by: row.rejected_by!, rule: row.rule!, violations: row.details.violations }),
    remaining: row.details.remaining_after,
    replayed,
  };
}
