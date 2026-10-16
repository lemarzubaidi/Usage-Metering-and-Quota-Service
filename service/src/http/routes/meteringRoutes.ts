import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import * as consumeService from '../../services/consume.js';
import * as meteringService from '../../services/metering.js';
import { consumeBody, historyQuery, parse, usageQuery } from '../schemas.js';

export function meteringRoutes(app: FastifyInstance, deps: { pool: pg.Pool; clock: () => Date }) {
  const { pool, clock } = deps;

  // Both outcomes are HTTP 200: the request itself was processed correctly, and the *answer* is
  // in the body (accepted: true | false). Errors in the request (400/401/404/409) use real error codes.
  app.post('/v1/consume', async (request) => {
    const body = parse(consumeBody, request.body);
    return consumeService.consume(pool, clock, request.account.id, body);
  });

  // Current consumption and remaining, for the account and optionally one user (?user_id=...&period=2026-10).
  app.get('/v1/usage', async (request) => {
    const q = parse(usageQuery, request.query);
    return meteringService.getUsage(pool, clock, request.account.id, q);
  });

  // Every accepted and rejected request, newest first (?user_id, ?period, ?decision, ?limit, ?cursor).
  app.get('/v1/history', async (request) => {
    const q = parse(historyQuery, request.query);
    return meteringService.getHistory(pool, clock, request.account.id, q);
  });
}
