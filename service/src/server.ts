import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './http/app.js';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);

  const app = buildApp({ pool, config });
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
