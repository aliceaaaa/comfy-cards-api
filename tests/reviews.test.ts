import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { env } from '../src/lib/env.js';
import { migrate } from '../src/db/migrate.js';
import { BOX_INTERVALS_IN_DAYS, MAX_BOX, nextReview } from '../src/lib/scheduler.js';

let app: FastifyInstance;
let token: string;
let otherToken: string;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

interface ReviewPayload {
  cardId: string;
  box: number;
  intervalDays: number;
  dueAt: number;
  correctCount: number;
  wrongCount: number;
}

async function register(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: 'supersecret1' },
  });

  assert.equal(response.statusCode, 201);

  return response.json<{ token: string }>().token;
}

async function createDeck(
  authToken: string,
  cards: { original: string; translation: string }[],
): Promise<{ id: string; dueCount: number; cards: { id: string; original: string }[] }> {
  const response = await app.inject({
    method: 'POST',
    url: '/decks',
    headers: { authorization: `Bearer ${authToken}` },
    payload: { title: 'Review deck', cards },
  });

  assert.equal(response.statusCode, 201);

  return response.json<{
    deck: { id: string; dueCount: number; cards: { id: string; original: string }[] };
  }>().deck;
}

async function review(authToken: string, cardId: string, correct: boolean) {
  return app.inject({
    method: 'POST',
    url: `/cards/${cardId}/review`,
    headers: { authorization: `Bearer ${authToken}` },
    payload: { correct },
  });
}

before(async () => {
  const { hostname, pathname } = new URL(env.DATABASE_URL);
  const isDisposable =
    hostname === 'localhost' || hostname === '127.0.0.1' || pathname.includes('test');

  if (!isDisposable) {
    throw new Error('tests wipe the database: point DATABASE_URL at localhost or a test database');
  }

  app = await buildServer({ logger: false });
  await app.ready();
  await migrate();
  await pool.query('DELETE FROM users WHERE email IN ($1, $2, $3)', [
    'reviewer@example.com',
    'stranger@example.com',
    'planner@example.com',
  ]);

  token = await register('reviewer@example.com');
  otherToken = await register('stranger@example.com');
});

after(async () => {
  await app.close();
  await pool.end();
});

describe('scheduler', () => {
  it('moves one box forward on a correct answer and back to zero on a wrong one', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    assert.deepEqual(nextReview(0, true, now), {
      box: 1,
      intervalDays: 1,
      dueAt: new Date(now.getTime() + DAY_IN_MS),
    });

    assert.deepEqual(nextReview(3, false, now), { box: 0, intervalDays: 0, dueAt: now });
  });

  it('stops growing at the last box', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const scheduled = nextReview(MAX_BOX, true, now);

    assert.equal(scheduled.box, MAX_BOX);
    assert.equal(scheduled.intervalDays, BOX_INTERVALS_IN_DAYS[MAX_BOX]);
  });
});

describe('reviews', () => {
  it('records an answer and schedules the next showing', async () => {
    const deck = await createDeck(token, [
      { original: 'eins', translation: 'one' },
      { original: 'zwei', translation: 'two' },
    ]);

    const first = await review(token, deck.cards[0]!.id, true);

    assert.equal(first.statusCode, 200);

    const afterFirst = first.json<{ review: ReviewPayload }>().review;

    assert.equal(afterFirst.box, 1);
    assert.equal(afterFirst.intervalDays, 1);
    assert.equal(afterFirst.correctCount, 1);
    assert.ok(afterFirst.dueAt > Date.now());

    const second = await review(token, deck.cards[0]!.id, true);
    const afterSecond = second.json<{ review: ReviewPayload }>().review;

    assert.equal(afterSecond.box, 2);
    assert.equal(afterSecond.intervalDays, 3);
    assert.equal(afterSecond.correctCount, 2);

    const third = await review(token, deck.cards[0]!.id, false);
    const afterThird = third.json<{ review: ReviewPayload }>().review;

    assert.equal(afterThird.box, 0);
    assert.equal(afterThird.intervalDays, 0);
    assert.equal(afterThird.correctCount, 2);
    assert.equal(afterThird.wrongCount, 1);
  });

  it('lists cards that are due and hides the ones scheduled for later', async () => {
    const deck = await createDeck(token, [
      { original: 'drei', translation: 'three' },
      { original: 'vier', translation: 'four' },
    ]);

    const before = await app.inject({
      method: 'GET',
      url: `/decks/${deck.id}/due`,
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(before.json<{ cards: unknown[] }>().cards.length, 2);

    await review(token, deck.cards[0]!.id, true);

    const after = await app.inject({
      method: 'GET',
      url: `/decks/${deck.id}/due`,
      headers: { authorization: `Bearer ${token}` },
    });

    const due = after.json<{ cards: { original: string }[] }>().cards;

    assert.equal(due.length, 1);
    assert.equal(due[0]?.original, 'vier');

    await review(token, deck.cards[0]!.id, false);

    const afterMistake = await app.inject({
      method: 'GET',
      url: `/decks/${deck.id}/due`,
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(afterMistake.json<{ cards: unknown[] }>().cards.length, 2);
  });

  it('keeps other people out', async () => {
    const deck = await createDeck(token, [{ original: 'fünf', translation: 'five' }]);

    const foreignReview = await review(otherToken, deck.cards[0]!.id, true);

    assert.equal(foreignReview.statusCode, 404);

    const foreignDue = await app.inject({
      method: 'GET',
      url: `/decks/${deck.id}/due`,
      headers: { authorization: `Bearer ${otherToken}` },
    });

    assert.equal(foreignDue.statusCode, 404);

    const anonymous = await review('', deck.cards[0]!.id, true);

    assert.equal(anonymous.statusCode, 401);
  });
});

describe('editing a deck', () => {
  it('keeps card ids and review progress for untouched cards', async () => {
    const deck = await createDeck(token, [
      { original: 'sechs', translation: 'six' },
      { original: 'sieben', translation: 'seven' },
    ]);

    await review(token, deck.cards[0]!.id, true);
    await review(token, deck.cards[0]!.id, true);

    const updated = await app.inject({
      method: 'PUT',
      url: `/decks/${deck.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'Review deck',
        cards: [
          { original: 'acht', translation: 'eight' },
          { original: 'sechs', translation: 'six' },
        ],
      },
    });

    const cards = updated.json<{ deck: { cards: { id: string; original: string }[] } }>().deck
      .cards;

    assert.equal(cards[0]?.original, 'acht');
    assert.equal(cards[1]?.original, 'sechs');
    assert.equal(cards[1]?.id, deck.cards[0]!.id);

    const stored = await pool.query<{ box: number }>(
      'SELECT box FROM card_reviews WHERE card_id = $1',
      [deck.cards[0]!.id],
    );

    assert.equal(stored.rows[0]?.box, 2);

    const removed = await pool.query('SELECT 1 FROM cards WHERE id = $1', [deck.cards[1]!.id]);

    assert.equal(removed.rowCount, 0);
  });
});

describe('due counts', () => {
  it('reports how many cards a deck has waiting', async () => {
    const deck = await createDeck(token, [
      { original: 'neun', translation: 'nine' },
      { original: 'zehn', translation: 'ten' },
    ]);

    assert.equal(deck.dueCount, 2);

    await review(token, deck.cards[0]!.id, true);

    const single = await app.inject({
      method: 'GET',
      url: `/decks/${deck.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(single.json<{ deck: { dueCount: number } }>().deck.dueCount, 1);

    const list = await app.inject({
      method: 'GET',
      url: '/decks',
      headers: { authorization: `Bearer ${token}` },
    });

    const listed = list
      .json<{ decks: { id: string; dueCount: number }[] }>()
      .decks.find((item) => {
        return item.id === deck.id;
      });

    assert.equal(listed?.dueCount, 1);
  });
});

describe('review across all decks', () => {
  it('collects due cards from every deck and respects the limit', async () => {
    const planner = await register('planner@example.com');

    const first = await createDeck(planner, [
      { original: 'uno', translation: 'one' },
      { original: 'dos', translation: 'two' },
    ]);
    await createDeck(planner, [{ original: 'tres', translation: 'three' }]);

    const all = await app.inject({
      method: 'GET',
      url: '/review/due',
      headers: { authorization: `Bearer ${planner}` },
    });

    const body = all.json<{
      cards: { original: string; deckId: string; deckTitle: string }[];
      total: number;
    }>();

    assert.equal(body.total, 3);
    assert.equal(body.cards.length, 3);
    assert.ok(body.cards.every((card) => {
      return card.deckTitle === 'Review deck' && typeof card.deckId === 'string';
    }));

    const limited = await app.inject({
      method: 'GET',
      url: '/review/due?limit=2',
      headers: { authorization: `Bearer ${planner}` },
    });

    const limitedBody = limited.json<{ cards: unknown[]; total: number }>();

    assert.equal(limitedBody.cards.length, 2);
    assert.equal(limitedBody.total, 3);

    await review(planner, first.cards[0]!.id, true);

    const afterReview = await app.inject({
      method: 'GET',
      url: '/review/due',
      headers: { authorization: `Bearer ${planner}` },
    });

    assert.equal(afterReview.json<{ total: number }>().total, 2);
  });

  it('does not reach into other accounts', async () => {
    const stranger = await app.inject({
      method: 'GET',
      url: '/review/due',
      headers: { authorization: `Bearer ${otherToken}` },
    });

    assert.equal(stranger.json<{ total: number }>().total, 0);

    const anonymous = await app.inject({ method: 'GET', url: '/review/due' });

    assert.equal(anonymous.statusCode, 401);
  });
});
