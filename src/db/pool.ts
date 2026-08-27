import pg from 'pg';
import { env } from '../lib/env.js';

const { Pool } = pg;

/**
 * Внутри Railway база доступна по приватному хосту без TLS,
 * снаружи (и у любого облачного провайдера) — только с TLS.
 */
function needsSsl(connectionString: string): boolean {
  if (connectionString.includes('sslmode=disable')) {
    return false;
  }

  const { hostname } = new URL(connectionString);

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return false;
  }

  if (hostname.endsWith('.railway.internal')) {
    return false;
  }

  return true;
}

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: needsSsl(env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

/** Выполняет работу в транзакции: коммит при успехе, откат при любой ошибке. */
export async function withTransaction<T>(
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await run(client);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
