import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createDeck, deleteDeck, getDeck, listDecks, updateDeck } from '../db/decks.js';
import { notFound } from '../lib/http-error.js';
import { parseInput } from '../lib/validate.js';

const cardSchema = z.object({
  original: z.string().trim().min(1, 'must not be empty').max(200),
  translation: z.string().trim().min(1, 'must not be empty').max(200),
});

const deckSchema = z.object({
  title: z.string().trim().min(1, 'is required').max(120),
  cards: z.array(cardSchema).max(1000, 'too many cards'),
});

const deckParamsSchema = z.object({
  id: z.string().uuid('must be a uuid'),
});

/** Все роуты колод требуют входа: хук навешан на весь плагин. */
export async function deckRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/decks', async (request) => {
    return { decks: await listDecks(request.user.sub) };
  });

  app.post('/decks', async (request, reply) => {
    const { title, cards } = parseInput(deckSchema, request.body);
    const deck = await createDeck(request.user.sub, title, cards);

    return reply.status(201).send({ deck });
  });

  app.get('/decks/:id', async (request) => {
    const { id } = parseInput(deckParamsSchema, request.params);
    const deck = await getDeck(request.user.sub, id);

    if (!deck) {
      throw notFound('Deck not found');
    }

    return { deck };
  });

  app.put('/decks/:id', async (request) => {
    const { id } = parseInput(deckParamsSchema, request.params);
    const { title, cards } = parseInput(deckSchema, request.body);
    const deck = await updateDeck(request.user.sub, id, title, cards);

    if (!deck) {
      throw notFound('Deck not found');
    }

    return { deck };
  });

  app.delete('/decks/:id', async (request, reply) => {
    const { id } = parseInput(deckParamsSchema, request.params);

    if (!(await deleteDeck(request.user.sub, id))) {
      throw notFound('Deck not found');
    }

    return reply.status(204).send();
  });
}
