import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { getAllowedOrigins } from './lib/env.js';
import { HttpError } from './lib/http-error.js';
import { authPlugin } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { deckRoutes } from './routes/decks.js';
import { reviewRoutes } from './routes/reviews.js';

export async function buildServer(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(cors, { origin: getAllowedOrigins() });
  await app.register(authPlugin);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode < 500) {
      return reply.status(statusCode).send({ error: error.message });
    }

    request.log.error(error);
    return reply.status(500).send({ error: 'Internal server error' });
  });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  await app.register(authRoutes);
  await app.register(deckRoutes);
  await app.register(catalogRoutes);
  await app.register(reviewRoutes);

  return app;
}
