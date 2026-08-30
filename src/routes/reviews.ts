import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listDueCards, ownsDeck, recordReview } from '../db/reviews.js';
import { notFound } from '../lib/http-error.js';
import { parseInput } from '../lib/validate.js';

const idParamsSchema = z.object({
  id: z.string().uuid('must be a uuid'),
});

const answerSchema = z.object({
  correct: z.boolean(),
});

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.post('/cards/:id/review', async (request) => {
    const { id } = parseInput(idParamsSchema, request.params);
    const { correct } = parseInput(answerSchema, request.body);
    const review = await recordReview(request.user.sub, id, correct);

    if (!review) {
      throw notFound('Card not found');
    }

    return { review };
  });

  app.get('/decks/:id/due', async (request) => {
    const { id } = parseInput(idParamsSchema, request.params);

    if (!(await ownsDeck(request.user.sub, id))) {
      throw notFound('Deck not found');
    }

    return { cards: await listDueCards(request.user.sub, id) };
  });
}
