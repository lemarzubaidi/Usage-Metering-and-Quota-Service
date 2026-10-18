import pg from 'pg';

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
    max: Number(process.env.DB_POOL_MAX ?? 10),
    options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000',
  });
}

export type Db = pg.Pool | pg.PoolClient;

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
      throw err;
    }
    throw err;
  } finally {
    client.release();
  }
}
