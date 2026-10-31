import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closeDb } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', 'migrations');

/**
 * Applies every migrations/*.sql file exactly once, in filename order.
 * Each migration runs in its own transaction and is recorded in schema_migrations.
 */
export async function migrate(): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const applied = new Set(
    (await pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
  );
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The migration files contain their own BEGIN/COMMIT; strip them so this wrapper owns the transaction.
      const body = sql.replace(/^\s*BEGIN;\s*/im, '').replace(/\s*COMMIT;\s*$/im, '');
      await client.query(body);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}

// CLI entry: `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then((ran) => {
      console.log(JSON.stringify({ level: 'INFO', msg: 'migrations complete', applied: ran }));
    })
    .catch((err) => {
      console.error(JSON.stringify({ level: 'ERROR', msg: String(err) }));
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
