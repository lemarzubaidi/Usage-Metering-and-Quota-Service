import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { periodLabel, periodStart } from '../domain/period.js';
import { evaluate, remainingOf, type Level, type RuleName } from '../domain/rules.js';
import { conflict, notFound } from '../errors.js';
import * as consumption from '../repositories/consumption.js';
import type { LogDetails, StoredOutcome } from '../repositories/consumption.js';

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

// The whole consume operation = ONE database transaction (see repositories/consumption.ts for the SQL):
//   1. find the user (inside the caller's own account only) and make sure this month's counters exist
//   2. LOCK the account counter and the user counter          <- concurrent requests of this account queue here
//   3. read, in one query: was this request_id already answered?  which plans apply right now?
//   4. idempotency: if it was answered, return the saved answer (or 409 if the data differs)
//   5. evaluate the four rules                                (pure function, no database)
//   6. save: add the units to both counters if accepted + write the request_log row (one statement)
//   7. COMMIT (releases the locks)
// Either all of it happens or none of it does.
export async function consume(
  pool: pg.Pool,
  clock: () => Date,
  accountId: number,
  input: ConsumeInput,
): Promise<ConsumeResult> {
  const period = periodStart(clock());

  return withTransaction(pool, async (tx) => {
    const userId = await consumption.resolveUserAndEnsureCounters(tx, accountId, input.user_id, period);
    if (userId === null) throw notFound(`User '${input.user_id}' not found`);

    const consumed = await consumption.lockCounters(tx, accountId, userId, period);

    // The idempotency check comes AFTER the lock. Every request of an account first locks the account
    // counter, so two requests with the same request_id cannot be here at the same time: the second one
    // waits, and when it gets the lock the first one's log row is already committed and visible.
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
}

// Rebuilds the saved answer (used for idempotent replays).
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
