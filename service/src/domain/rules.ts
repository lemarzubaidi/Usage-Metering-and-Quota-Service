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

export interface Rule {
  level: Level;
  name: RuleName;
  check(input: EvaluateInput): Violation | null;
}

export function remainingOf(limits: Limits, consumed: number): number {
  return Math.max(0, limits.monthly_allowance - consumed);
}

const limitsOf = (input: EvaluateInput, level: Level) => (level === 'user' ? input.user : input.account);
const consumedOf = (input: EvaluateInput, level: Level) => (level === 'user' ? input.consumedUser : input.consumedAccount);

export const maxPerRequest = (level: Level): Rule => ({
  level,
  name: 'max_per_request',
  check(input) {
    const limit = limitsOf(input, level).max_per_request;
    return input.units > limit ? { level, rule: 'max_per_request', limit, requested: input.units } : null;
  },
});

export const monthlyAllowance = (level: Level): Rule => ({
  level,
  name: 'monthly_allowance',
  check(input) {
    const limits = limitsOf(input, level);
    const consumed = consumedOf(input, level);
    if (consumed + input.units <= limits.monthly_allowance) return null;
    return {
      level,
      rule: 'monthly_allowance',
      limit: limits.monthly_allowance,
      requested: input.units,
      consumed,
      remaining: remainingOf(limits, consumed),
    };
  },
});

export const DEFAULT_RULES: readonly Rule[] = [
  maxPerRequest('user'),
  maxPerRequest('account'),
  monthlyAllowance('user'),
  monthlyAllowance('account'),
];

export function evaluate(input: EvaluateInput, rules: readonly Rule[] = DEFAULT_RULES): Decision {
  const violations = rules.map((rule) => rule.check(input)).filter((v): v is Violation => v !== null);
  const first = violations[0];
  if (!first) return { accepted: true };
  return { accepted: false, rejected_by: first.level, rule: first.rule, violations };
}
