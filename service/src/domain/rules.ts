// THE decision logic. Pure functions: no database, no HTTP, no clock. Same input -> same output,
// so it can be tested exhaustively and read in one sitting.
//
// A request for `units` by one user is accepted only if ALL FOUR checks pass:
//   1. units <= user.max_per_request
//   2. units <= account.max_per_request
//   3. consumed_user    + units <= user.monthly_allowance
//   4. consumed_account + units <= account.monthly_allowance
// The boundary is inclusive: exactly reaching a limit is allowed.

export interface Limits {
  monthly_allowance: number;
  max_per_request: number;
}

export type Level = 'user' | 'account';
export type RuleName = 'max_per_request' | 'monthly_allowance';

export interface Violation {
  level: Level;
  rule: RuleName;
  limit: number; // the number that was exceeded (max_per_request, or monthly_allowance)
  requested: number;
  consumed?: number; // only for monthly_allowance: units already used this month
  remaining?: number; // only for monthly_allowance: max(0, allowance - consumed)
}

export interface EvaluateInput {
  units: number;
  user: Limits;
  account: Limits;
  consumedUser: number;
  consumedAccount: number;
}

export type Decision =
  | { accepted: true }
  | {
      accepted: false;
      rejected_by: Level; // who is "to blame" for the headline reason (first violation)
      rule: RuleName; // which rule it was
      violations: Violation[]; // EVERY rule that failed, in the fixed order below
    };

// Remaining is computed, never stored. It is never negative: if a plan was lowered below what was
// already consumed, the remaining is 0 (not a negative number).
export function remainingOf(limits: Limits, consumed: number): number {
  return Math.max(0, limits.monthly_allowance - consumed);
}

// Fixed check order (also the order of `violations`; the first one is the headline reason):
//   per-request limits before monthly limits, and user before account inside each group.
// Why: "this single request is too big" is the most specific thing to tell the caller, and
// a request that is too big would fail forever, whereas a monthly limit fixes itself next month.
export function evaluate(input: EvaluateInput): Decision {
  const { units, user, account, consumedUser, consumedAccount } = input;
  const violations: Violation[] = [];

  if (units > user.max_per_request) {
    violations.push({ level: 'user', rule: 'max_per_request', limit: user.max_per_request, requested: units });
  }
  if (units > account.max_per_request) {
    violations.push({ level: 'account', rule: 'max_per_request', limit: account.max_per_request, requested: units });
  }
  if (consumedUser + units > user.monthly_allowance) {
    violations.push({
      level: 'user',
      rule: 'monthly_allowance',
      limit: user.monthly_allowance,
      requested: units,
      consumed: consumedUser,
      remaining: remainingOf(user, consumedUser),
    });
  }
  if (consumedAccount + units > account.monthly_allowance) {
    violations.push({
      level: 'account',
      rule: 'monthly_allowance',
      limit: account.monthly_allowance,
      requested: units,
      consumed: consumedAccount,
      remaining: remainingOf(account, consumedAccount),
    });
  }

  const first = violations[0];
  if (!first) return { accepted: true };
  return { accepted: false, rejected_by: first.level, rule: first.rule, violations };
}
