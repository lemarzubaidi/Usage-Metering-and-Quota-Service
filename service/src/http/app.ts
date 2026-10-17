import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { authenticateAccount } from './auth.js';
import { accountRoutes } from './routes/accountRoutes.js';
import { adminRoutes } from './routes/admin.js';
import { meteringRoutes } from './routes/meteringRoutes.js';

export function buildApp(deps: { pool: pg.Pool; config: Config; clock?: () => Date }): FastifyInstance {
  const { pool, config } = deps;
  const clock = deps.clock ?? (() => new Date());
  const app = Fastify({ logger: config.logLevel === 'silent' ? false : { level: config.logLevel } });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }

    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'invalid_request', message: (err as Error).message } });
    }
    request.log.error(err);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } }),
  );

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  adminRoutes(app, { pool, adminApiKey: config.adminApiKey });

  app.register(async (v1) => {
    v1.addHook('onRequest', authenticateAccount(pool));
    accountRoutes(v1, { pool });
    meteringRoutes(v1, { pool, clock });
  });

  return app;
}
