import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './http/app.js';

// Start-up order: read config -> connect -> apply migrations (creates tables + seeds predefined plans)
// -> start listening. This is what makes `docker compose up --build` work with no manual database step.
async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);

  const app = buildApp({ pool, config });
  await app.listen({ port: config.port, host: config.host });

  // Docker sends SIGTERM on `docker compose down`: finish in-flight requests, then close the pool.
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
