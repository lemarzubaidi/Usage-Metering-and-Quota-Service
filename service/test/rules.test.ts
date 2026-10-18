import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, evaluate, remainingOf } from '../src/domain/rules.js';
import { parsePeriodLabel, periodStart } from '../src/domain/period.js';

const user = { monthly_allowance: 1000, max_per_request: 20 };
const account = { monthly_allowance: 10000, max_per_request: 100 };
const base = { user, account, consumedUser: 0, consumedAccount: 0 };

describe('evaluate: the four rules', () => {
  it('accepts a request that satisfies all four', () => {
    expect(evaluate({ ...base, units: 10 })).toEqual({ accepted: true });
  });

  it('accepts exactly at every limit (boundary is inclusive)', () => {
    expect(evaluate({ ...base, units: 20 }).accepted).toBe(true);
    expect(evaluate({ ...base, units: 20, consumedUser: 980 }).accepted).toBe(true);
    expect(evaluate({ ...base, units: 20, consumedAccount: 9980 }).accepted).toBe(true);
    expect(evaluate({ user: { monthly_allowance: 500, max_per_request: 200 }, account: { monthly_allowance: 500, max_per_request: 100 }, units: 100, consumedUser: 0, consumedAccount: 0 }).accepted).toBe(true);
  });

  it('rejects one unit over each limit and says which one', () => {
    const r1 = evaluate({ ...base, units: 21 });
    expect(r1).toMatchObject({ accepted: false, rejected_by: 'user', rule: 'max_per_request' });

    const r2 = evaluate({ user: { monthly_allowance: 1000, max_per_request: 500 }, account, units: 101, consumedUser: 0, consumedAccount: 0 });
    expect(r2).toMatchObject({ accepted: false, rejected_by: 'account', rule: 'max_per_request' });

    const r3 = evaluate({ ...base, units: 11, consumedUser: 990 });
    expect(r3).toMatchObject({ accepted: false, rejected_by: 'user', rule: 'monthly_allowance' });

    const r4 = evaluate({ ...base, units: 11, consumedAccount: 9990 });
    expect(r4).toMatchObject({ accepted: false, rejected_by: 'account', rule: 'monthly_allowance' });
  });

  it('a user with allowance left is still rejected when the account has run out', () => {
    const d = evaluate({ ...base, units: 5, consumedUser: 0, consumedAccount: 9998 });
    expect(d).toMatchObject({ accepted: false, rejected_by: 'account', rule: 'monthly_allowance' });
  });

  it('reports every violated rule, in the fixed order, headline = first', () => {
    const d = evaluate({ user: { monthly_allowance: 10, max_per_request: 5 }, account: { monthly_allowance: 10, max_per_request: 5 }, units: 8, consumedUser: 9, consumedAccount: 9 });
    if (d.accepted) throw new Error('should be rejected');
    expect(d.violations.map((v) => `${v.level}:${v.rule}`)).toEqual([
      'user:max_per_request',
      'account:max_per_request',
      'user:monthly_allowance',
      'account:monthly_allowance',
    ]);
    expect(d.rejected_by).toBe('user');
    expect(d.rule).toBe('max_per_request');
  });

  it('puts per-request before monthly and user before account', () => {
    const d = evaluate({ ...base, units: 11, consumedUser: 995, consumedAccount: 9995 });
    if (d.accepted) throw new Error('should be rejected');
    expect(d.violations.map((v) => `${v.level}:${v.rule}`)).toEqual(['user:monthly_allowance', 'account:monthly_allowance']);
  });

  it('includes consumed and remaining in monthly violations', () => {
    const d = evaluate({ ...base, units: 11, consumedUser: 995 });
    if (d.accepted) throw new Error('should be rejected');
    expect(d.violations[0]).toMatchObject({ limit: 1000, requested: 11, consumed: 995, remaining: 5 });
  });
});

describe('remainingOf', () => {
  it('is allowance minus consumed', () => expect(remainingOf(user, 400)).toBe(600));
  it('never goes negative after a plan was lowered below consumption', () => expect(remainingOf({ monthly_allowance: 50, max_per_request: 5 }, 90)).toBe(0));
  it('a zero allowance has zero remaining and rejects everything', () => {
    const zero = { monthly_allowance: 0, max_per_request: 5 };
    expect(remainingOf(zero, 0)).toBe(0);
    expect(evaluate({ ...base, user: zero, units: 1 }).accepted).toBe(false);
  });
});

describe('periods (UTC calendar months)', () => {
  it('uses the first day of the UTC month', () => {
    expect(periodStart(new Date('2026-10-15T12:00:00Z'))).toBe('2026-10-01');
    expect(periodStart(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-01');
    expect(periodStart(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01-01');
  });
  it('decides by UTC, not by local time', () => {
    expect(periodStart(new Date('2026-11-01T01:30:00Z'))).toBe('2026-11-01');
    expect(periodStart(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10-01');
  });
  it('parses year-month labels', () => {
    expect(parsePeriodLabel('2026-10')).toBe('2026-10-01');
    expect(parsePeriodLabel('2026-13')).toBeNull();
    expect(parsePeriodLabel('2026-1')).toBeNull();
    expect(parsePeriodLabel('abc')).toBeNull();
  });
});

describe('rules as strategies', () => {
  it('lets a new rule be added without changing evaluate()', () => {
    const noBigRequestsAtNight = {
      level: 'account' as const,
      name: 'max_per_request' as const,
      check: (input: { units: number }) =>
        input.units > 5 ? { level: 'account' as const, rule: 'max_per_request' as const, limit: 5, requested: input.units } : null,
    };
    const rules = [...DEFAULT_RULES, noBigRequestsAtNight];
    expect(evaluate({ ...base, units: 10 }, rules)).toMatchObject({ accepted: false, rejected_by: 'account' });
    expect(evaluate({ ...base, units: 10 })).toEqual({ accepted: true });
  });

  it('keeps the fixed order: per-request before monthly, user before account', () => {
    expect(DEFAULT_RULES.map((r) => `${r.level}:${r.name}`)).toEqual([
      'user:max_per_request',
      'account:max_per_request',
      'user:monthly_allowance',
      'account:monthly_allowance',
    ]);
  });
});
