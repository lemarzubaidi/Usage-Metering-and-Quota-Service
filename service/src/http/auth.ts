import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { extractBearer, hashApiKey, safeEqual } from '../auth/apiKey.js';
import { unauthorized } from '../errors.js';
import * as accountsRepo from '../repositories/accounts.js';
import type { AccountWithPlan } from '../repositories/accounts.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Set by authenticateAccount; every /v1 handler reads the account from here and NEVER from the request body.
    account: AccountWithPlan;
  }
}

// Runs before every /v1 handler. Which account is calling is decided ONLY by the API key.
export function authenticateAccount(pool: pg.Pool) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const key = extractBearer(request.headers.authorization);
    if (!key) throw unauthorized();
    const account = await accountsRepo.findByKeyHash(pool, hashApiKey(key));
    if (!account) throw unauthorized();
    request.account = account;
  };
}

// Admin endpoints are protected by a single key from the environment.
export function authenticateAdmin(adminApiKey: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const key = extractBearer(request.headers.authorization);
    if (!key || !safeEqual(key, adminApiKey)) throw unauthorized();
  };
}
