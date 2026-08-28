import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { env } from '../src/lib/env.js';
import { ensureCatalogOwner, seed, upsertCatalogDeck } from '../src/db/seed.js';

function assertDisposableDatabase(url: string): void {
  const { hostname, pathname } = new URL(url);
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const looksLikeTestDatabase = pathname.includes('test');

  if (!isLocal && !looksLikeTestDatabase) {
    throw new Error(
      'tests wipe the database: point DATABASE_URL at localhost or a database whose name contains "test"',
    );
  }
}

let app: FastifyInstance;
let token: string;

async function register(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: 'supersecret1' },
  });

  assert.equal(response.statusCode, 201);

  return response.json<{ token: string }>().token;
}

before(async () => {
  assertDisposableDatabase(env.DATABASE_URL);

  app = await buildServer({ logger: false });
  await app.ready();

  await seed();
  await pool.query('DELETE FROM users WHERE email <> $1', ['catalog@comfy-cards.local']);

  token = await register('learner@example.com');
});

after(async () => {
  await app.close();
  await pool.end();
});

describe('transcription', () => {
  it('survives a write and read round trip', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/decks',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'Japanese',
        cards: [{ original: 'ねこ', translation: 'cat', transcription: 'neko' }],
      },
    });

    assert.equal(created.statusCode, 201);
    const deckId = created.json<{ deck: { id: string } }>().deck.id;

    const updated = await app.inject({
      method: 'PUT',
      url: `/decks/${deckId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'Japanese',
        cards: [
          { original: 'ねこ', translation: 'cat', transcription: 'neko' },
          { original: 'いぬ', translation: 'dog', transcription: '  inu  ' },
          { original: 'とり', translation: 'bird', transcription: '' },
        ],
      },
    });

    assert.equal(updated.statusCode, 200);

    const read = await app.inject({
      method: 'GET',
      url: `/decks/${deckId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const cards = read.json<{ deck: { cards: Record<string, string>[] } }>().deck.cards;

    assert.equal(cards[0]?.transcription, 'neko');
    assert.equal(cards[1]?.transcription, 'inu');
    assert.ok(!('transcription' in (cards[2] ?? {})));
  });
});

describe('catalog', () => {
  it('is readable without a token and hides cards', async () => {
    const response = await app.inject({ method: 'GET', url: '/catalog' });

    assert.equal(response.statusCode, 200);

    const body = response.json<{
      decks: { slug: string; cardCount: number }[];
      total: number;
    }>();

    assert.equal(body.total, 5);
    assert.equal(body.decks.length, 5);

    const hiragana = body.decks.find((deck) => {
      return deck.slug === 'hiragana';
    });

    assert.equal(hiragana?.cardCount, 46);
    assert.ok(!('cards' in (hiragana ?? {})));
  });

  it('filters by language and query', async () => {
    const response = await app.inject({ method: 'GET', url: '/catalog?language=de&q=basics' });
    const body = response.json<{ decks: { slug: string }[]; total: number }>();

    assert.equal(body.total, 1);
    assert.equal(body.decks[0]?.slug, 'german');
  });

  it('returns one deck with its cards by slug', async () => {
    const response = await app.inject({ method: 'GET', url: '/catalog/hiragana' });
    const deck = response.json<{ deck: { cards: { original: string }[] } }>().deck;

    assert.equal(deck.cards.length, 46);
    assert.equal(deck.cards[0]?.original, 'あ');
  });

  it('does not leak catalog decks into personal lists', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/decks',
      headers: { authorization: `Bearer ${token}` },
    });

    const slugs = list.json<{ decks: { title: string }[] }>().decks.map((deck) => {
      return deck.title;
    });

    assert.ok(!slugs.includes('Hiragana'));

    const catalogDeckId = (
      await pool.query<{ id: string }>('SELECT id FROM decks WHERE slug = $1', ['hiragana'])
    ).rows[0]?.id;

    const direct = await app.inject({
      method: 'GET',
      url: `/decks/${catalogDeckId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(direct.statusCode, 404);
  });

  it('copies a catalog deck into the account keeping card order', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/decks/from/hiragana',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.statusCode, 201);

    const deck = response.json<{ deck: { id: string; cards: { original: string }[] } }>().deck;

    assert.equal(deck.cards.length, 46);
    assert.equal(deck.cards[0]?.original, 'あ');
    assert.equal(deck.cards[45]?.original, 'ん');

    const owned = await app.inject({
      method: 'GET',
      url: `/decks/${deck.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(owned.statusCode, 200);
  });

  it('refuses an unknown slug and requires a token to copy', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/decks/from/nope',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(missing.statusCode, 404);

    const anonymous = await app.inject({ method: 'POST', url: '/decks/from/hiragana' });

    assert.equal(anonymous.statusCode, 401);
  });
});

describe('seed', () => {
  it('is idempotent and picks up content edits', async () => {
    const countDecks = async () => {
      const result = await pool.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM decks WHERE is_public',
      );

      return result.rows[0]?.count ?? 0;
    };

    await seed();
    const afterSecondRun = await countDecks();

    await seed();

    assert.equal(await countDecks(), afterSecondRun);
    assert.equal(afterSecondRun, 5);

    const ownerId = await ensureCatalogOwner();

    await upsertCatalogDeck(ownerId, {
      slug: 'hiragana',
      title: 'Hiragana edited',
      description: 'edited',
      language: 'ja',
      topic: 'writing',
      cards: [{ original: 'あ', translation: 'a' }],
    });

    const edited = await app.inject({ method: 'GET', url: '/catalog/hiragana' });
    const deck = edited.json<{ deck: { title: string; cardCount: number } }>().deck;

    assert.equal(deck.title, 'Hiragana edited');
    assert.equal(deck.cardCount, 1);
    assert.equal(await countDecks(), 5);

    await seed();

    const restored = await app.inject({ method: 'GET', url: '/catalog/hiragana' });

    assert.equal(restored.json<{ deck: { cardCount: number } }>().deck.cardCount, 46);
  });
});
