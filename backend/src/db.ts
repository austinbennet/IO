import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.database.url,
  max: config.database.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // Idle client errors must not crash the process; health checks report DB status.
  console.error(JSON.stringify({ level: 'ERROR', source: 'db', msg: 'idle client error', err: err.message }));
});

export type Queryable = Pick<pg.Pool, 'query'>;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = pool,
): Promise<pg.QueryResult<T>> {
  return client.query<T>(text, params as unknown[]);
}

/** Runs fn inside a transaction; rolls back on any thrown error. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
