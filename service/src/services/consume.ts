import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { periodLabel, periodStart } from '../domain/period.js';
import type { DecisionEvents } from '../domain/events.js';
import { evaluate, remainingOf, type Level, type RuleName } from '../domain/rules.js';
import { conflict, notFound } from '../errors.js';
import * as consumption from '../repositories/consumption.js';
import type { LogDetails, StoredOutcome } from '../repositories/consumption.js';

export interface ConsumeInput {
  user_id: string;
  request_id: string;
  units: number;
}

export interface ConsumeResult {
  accepted: boolean;
  request_id: string;
  user_id: string;
  units: number;
  period: string;
  rejected_by?: Level;
  rule?: RuleName;
  violations?: unknown[];
  remaining: { user: number; account: number };
  replayed: boolean;
}

export async function consume(
  pool: pg.Pool,
  clock: () => Date,
  accountId: number,
  input: ConsumeInput,
  events?: DecisionEvents,
): Promise<ConsumeResult> {
  const period = periodStart(clock());

  const result = await withTransaction(pool, async (tx) => {
    const userId = await consumption.resolveUserAndEnsureCounters(tx, accountId, input.user_id, period);
    if (userId === null) throw notFound(`User '${input.user_id}' not found`);

    const consumed = await consumption.lockCounters(tx, accountId, userId, period);

    const { existing, user, account } = await consumption.readContext(tx, accountId, userId, input.request_id);
    if (existing) {
      if (existing.user_id !== userId || existing.units !== input.units) {
        throw conflict(
          'request_id_conflict',
          `request_id '${input.request_id}' was already used with different data (user or units)`,
        );
      }
      return fromStored(existing, true);
    }

    const decision = evaluate({
      units: input.units,
      user,
      account,
      consumedUser: consumed.user,
      consumedAccount: consumed.account,
    });

    const added = decision.accepted ? input.units : 0;
    const details: LogDetails = {
      limits: { user, account },
      consumed_before: { user: consumed.user, account: consumed.account },
      remaining_after: {
        user: remainingOf(user, consumed.user + added),
        account: remainingOf(account, consumed.account + added),
      },
      violations: decision.accepted ? [] : decision.violations,
    };

    await consumption.recordDecision(tx, {
      accountId,
      userId,
      requestId: input.request_id,
      units: input.units,
      accepted: decision.accepted,
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

  events?.publish({
    accountId,
    userId: input.user_id,
    requestId: input.request_id,
    units: input.units,
    accepted: result.accepted,
    replayed: result.replayed,
    rejectedBy: result.rejected_by,
    rule: result.rule,
  });
  return result;
}

function fromStored(row: StoredOutcome, replayed: boolean): ConsumeResult {
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
