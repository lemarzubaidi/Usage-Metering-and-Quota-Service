import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import * as consumeService from '../../services/consume.js';
import { consumeBody, parse } from '../schemas.js';

export function meteringRoutes(app: FastifyInstance, deps: { pool: pg.Pool; clock: () => Date }) {
  const { pool, clock } = deps;

  // Both outcomes are HTTP 200: the request itself was processed correctly, and the *answer* is
  // in the body (accepted: true | false). Errors in the request (400/401/404/409) use real error codes.
  app.post('/v1/consume', async (request) => {
    const body = parse(consumeBody, request.body);
    return consumeService.consume(pool, clock, request.account.id, body);
  });
}
