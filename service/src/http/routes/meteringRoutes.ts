import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import * as consumeService from '../../services/consume.js';
import * as meteringService from '../../services/metering.js';
import { consumeBody, historyQuery, parse, usageQuery } from '../schemas.js';

export function meteringRoutes(app: FastifyInstance, deps: { pool: pg.Pool; clock: () => Date }) {
  const { pool, clock } = deps;

  app.post('/v1/consume', async (request) => {
    const body = parse(consumeBody, request.body);
    return consumeService.consume(pool, clock, request.account.id, body);
  });

  app.get('/v1/usage', async (request) => {
    const q = parse(usageQuery, request.query);
    return meteringService.getUsage(pool, clock, request.account.id, q);
  });

  app.get('/v1/history', async (request) => {
    const q = parse(historyQuery, request.query);
    return meteringService.getHistory(pool, clock, request.account.id, q);
  });
}
