import pg from 'pg';

// Type parsers: by default node-postgres returns BIGINT as a string and DATE as a JS Date
// (which silently shifts by the server's time zone). We want plain numbers and plain 'YYYY-MM-DD'.
//   20   = BIGINT (int8)
//   1082 = DATE
// Numbers are exact up to 2^53 - 1; we refuse to read anything larger instead of rounding it.
pg.types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`BIGINT value ${value} is too large for a JS number`);
  return n;
});
pg.types.setTypeParser(1082, (value: string) => value);

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX ?? 20),
  });
}

// Anything we can run a query on: the pool itself, or one connection checked out for a transaction.
export type Db = pg.Pool | pg.PoolClient;

// Runs fn inside BEGIN ... COMMIT on ONE connection; rolls back if fn throws.
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the original error is the interesting one */
    }
    throw err;
  } finally {
    client.release();
  }
}
