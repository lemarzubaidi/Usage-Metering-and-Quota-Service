import pg from 'pg';

// BIGINT columns come back as strings by default (JS numbers lose precision above 2^53).
// We keep them as strings at the DB boundary and convert deliberately where needed.
export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX ?? 20),
  });
}
