export interface Limits {
  monthly_allowance: number;
  max_per_request: number;
}

export type Level = 'user' | 'account';
export type RuleName = 'max_per_request' | 'monthly_allowance';

export interface Violation {
  level: Level;
  rule: RuleName;
  limit: number;
  requested: number;
  consumed?: number;
  remaining?: number;
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
      rejected_by: Level;
      rule: RuleName;
      violations: Violation[];
    };

export function remainingOf(limits: Limits, consumed: number): number {
  return Math.max(0, limits.monthly_allowance - consumed);
}

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
