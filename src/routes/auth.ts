import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createUser, findUserByEmail } from '../db/users.js';
import { conflict, unauthorized } from '../lib/http-error.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { parseInput } from '../lib/validate.js';

const credentialsSchema = z.object({
  email: z.string().trim().email('must be a valid email').max(255),
  password: z.string().min(8, 'must be at least 8 characters').max(200),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', async (request, reply) => {
    const { email, password } = parseInput(credentialsSchema, request.body);
    const normalizedEmail = email.toLowerCase();

    if (await findUserByEmail(normalizedEmail)) {
      throw conflict('This email is already registered');
    }

    const user = await createUser(normalizedEmail, await hashPassword(password));

    return reply.status(201).send({
      token: app.jwt.sign({ sub: user.id, email: user.email }),
      user,
    });
  });

  app.post('/auth/login', async (request) => {
    const { email, password } = parseInput(credentialsSchema, request.body);
    const row = await findUserByEmail(email.toLowerCase());

    if (!row) {
      throw unauthorized('Wrong email or password');
    }

    if (!(await verifyPassword(password, row.password_hash))) {
      throw unauthorized('Wrong email or password');
    }

    return {
      token: app.jwt.sign({ sub: row.id, email: row.email }),
      user: { id: row.id, email: row.email },
    };
  });

  app.get('/auth/me', { preHandler: app.authenticate }, async (request) => {
    return { user: { id: request.user.sub, email: request.user.email } };
  });
}
