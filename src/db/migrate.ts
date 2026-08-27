import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { pool } from './pool.js';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Применяет все ещё не применённые .sql из migrations/ по возрастанию имени. */
export async function migrate(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    );

    const applied = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const appliedNames = new Set(
      applied.rows.map((row) => {
        return row.name;
      }),
    );

    const files = (await readdir(migrationsDir))
      .filter((file) => {
        return file.endsWith('.sql');
      })
      .sort();

    for (const file of files) {
      if (appliedNames.has(file)) {
        continue;
      }

      const sql = await readFile(join(migrationsDir, file), 'utf8');

      await client.query('BEGIN');

      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`миграция применена: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  migrate()
    .then(() => {
      return pool.end();
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
