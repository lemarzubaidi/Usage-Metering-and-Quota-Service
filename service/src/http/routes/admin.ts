import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import * as accountsService from '../../services/accounts.js';
import { authenticateAdmin } from '../auth.js';
import { createAccountBody, parse } from '../schemas.js';
import { accountView } from '../view.js';

export function adminRoutes(app: FastifyInstance, deps: { pool: pg.Pool; adminApiKey: string }) {
  app.register(async (admin) => {
    admin.addHook('onRequest', authenticateAdmin(deps.adminApiKey));

    // Creates an account and returns its API key. This is the ONLY time the key is ever shown.
    admin.post('/admin/accounts', async (request, reply) => {
      const body = parse(createAccountBody, request.body);
      const { account, apiKey } = await accountsService.createAccount(deps.pool, body);
      return reply.code(201).send({ account: accountView(account), api_key: apiKey });
    });
  });
}
