import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { copyCatalogDeck, exportCatalog, getCatalogDeck, listCatalog } from '../db/catalog.js';
import { notFound } from '../lib/http-error.js';
import { parseInput } from '../lib/validate.js';

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => {
      if (!value || value.length === 0) {
        return undefined;
      }

      return value;
    });
}

const catalogQuerySchema = z.object({
  language: optionalText(20),
  topic: optionalText(40),
  q: optionalText(100),
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const slugParamsSchema = z.object({
  slug: z.string().trim().min(1).max(80),
});

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/catalog', async (request) => {
    const filters = parseInput(catalogQuerySchema, request.query);

    return listCatalog(filters);
  });

  app.get('/catalog/export', async () => {
    return { decks: await exportCatalog() };
  });

  app.get('/catalog/:slug', async (request) => {
    const { slug } = parseInput(slugParamsSchema, request.params);
    const deck = await getCatalogDeck(slug);

    if (!deck) {
      throw notFound('Deck not found');
    }

    return { deck };
  });

  app.post('/decks/from/:slug', { preHandler: app.authenticate }, async (request, reply) => {
    const { slug } = parseInput(slugParamsSchema, request.params);
    const deck = await copyCatalogDeck(request.user.sub, slug);

    if (!deck) {
      throw notFound('Deck not found');
    }

    return reply.status(201).send({ deck });
  });
}
