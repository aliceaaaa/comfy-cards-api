import { pool } from './pool.js';
import { PublicUser } from '../types.js';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const result = await pool.query<UserRow>(
    'SELECT id, email, password_hash FROM users WHERE email = $1',
    [email],
  );

  return result.rows[0];
}

export async function createUser(email: string, passwordHash: string): Promise<PublicUser> {
  const result = await pool.query<{ id: string; email: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
    [email, passwordHash],
  );

  const row = result.rows[0];

  if (!row) {
    throw new Error('не удалось создать пользователя');
  }

  return row;
}
