import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { extractBearer, safeEqual } from '../auth/apiKey.js';
import { unauthorized } from '../errors.js';
import * as accountsService from '../services/accounts.js';
import type { AccountWithPlan } from '../services/accounts.js';

declare module 'fastify' {
  interface FastifyRequest {
    account: AccountWithPlan;
  }
}

export function authenticateAccount(pool: pg.Pool) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const key = extractBearer(request.headers.authorization);
    if (!key) throw unauthorized();
    const account = await accountsService.authenticate(pool, key);
    if (!account) throw unauthorized();
    request.account = account;
  };
}

export function authenticateAdmin(adminApiKey: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const key = extractBearer(request.headers.authorization);
    if (!key || !safeEqual(key, adminApiKey)) throw unauthorized();
  };
}
