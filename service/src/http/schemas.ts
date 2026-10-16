import { z } from 'zod';
import { badRequest } from '../errors.js';

// Zod schemas = the contract for what a request may contain. Anything else -> 400 with the list of problems.
// .strict() rejects unknown fields so a typo like "unit" instead of "units" is an error, not silently ignored.

const MAX = Number.MAX_SAFE_INTEGER;

export const positiveInt = z.number().int().positive().max(MAX);
export const nonNegativeInt = z.number().int().min(0).max(MAX);
const name = z.string().trim().min(1).max(100);
const externalId = z.string().trim().min(1).max(200);

export const scopeSchema = z.enum(['account', 'user']);

export const createAccountBody = z.object({ name, plan_id: positiveInt.optional() }).strict();
export const createPlanBody = z
  .object({ name, scope: scopeSchema, monthly_allowance: nonNegativeInt, max_per_request: positiveInt })
  .strict();
export const updatePlanBody = z
  .object({ name: name.optional(), monthly_allowance: nonNegativeInt.optional(), max_per_request: positiveInt.optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Send at least one field to change' });
export const setPlanBody = z.object({ plan_id: positiveInt }).strict();
export const createUserBody = z.object({ user_id: externalId, plan_id: positiveInt.optional() }).strict();
export const consumeBody = z
  .object({ user_id: externalId, request_id: z.string().trim().min(1).max(200), units: positiveInt })
  .strict();

export const idParam = z.string().regex(/^\d{1,15}$/, 'must be a positive integer').transform(Number);

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Validates `data` against `schema` or throws a 400 AppError listing every problem.
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message }));
    throw badRequest('Invalid request', issues);
  }
  return result.data;
}
