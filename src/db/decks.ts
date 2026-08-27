import type { PoolClient } from 'pg';
import { pool, withTransaction } from './pool.js';
import { Card, Deck } from '../types.js';

export interface CardInput {
  original: string;
  translation: string;
}

interface DeckRow {
  id: string;
  title: string;
  created_at: Date;
}

interface CardRow {
  id: string;
  deck_id: string;
  original: string;
  translation: string;
}

function toDeck(row: DeckRow, cards: Card[]): Deck {
  return {
    id: row.id,
    title: row.title,
    cards,
    createdAt: row.created_at.getTime(),
  };
}

function toCard(row: CardRow): Card {
  return {
    id: row.id,
    original: row.original,
    translation: row.translation,
  };
}

/** Карточки всех переданных колод одним запросом — чтобы не делать N+1. */
async function readCards(deckIds: string[]): Promise<Map<string, Card[]>> {
  const byDeck = new Map<string, Card[]>();

  if (deckIds.length === 0) {
    return byDeck;
  }

  const result = await pool.query<CardRow>(
    `SELECT id, deck_id, original, translation
     FROM cards
     WHERE deck_id = ANY ($1::uuid[])
     ORDER BY deck_id, position`,
    [deckIds],
  );

  for (const row of result.rows) {
    const cards = byDeck.get(row.deck_id) ?? [];

    cards.push(toCard(row));
    byDeck.set(row.deck_id, cards);
  }

  return byDeck;
}

/** Полностью заменяет карточки колоды: старые удаляются, новые вставляются по порядку. */
async function replaceCards(
  client: PoolClient,
  deckId: string,
  cards: CardInput[],
): Promise<Card[]> {
  await client.query('DELETE FROM cards WHERE deck_id = $1', [deckId]);

  if (cards.length === 0) {
    return [];
  }

  const originals = cards.map((card) => {
    return card.original;
  });
  const translations = cards.map((card) => {
    return card.translation;
  });
  const positions = cards.map((card, index) => {
    return index;
  });

  const result = await client.query<CardRow & { position: number }>(
    `INSERT INTO cards (deck_id, original, translation, position)
     SELECT $1, original, translation, position
     FROM unnest($2::text[], $3::text[], $4::int[]) AS input (original, translation, position)
     RETURNING id, deck_id, original, translation, position`,
    [deckId, originals, translations, positions],
  );

  return result.rows
    .sort((left, right) => {
      return left.position - right.position;
    })
    .map(toCard);
}

export async function listDecks(userId: string): Promise<Deck[]> {
  const result = await pool.query<DeckRow>(
    'SELECT id, title, created_at FROM decks WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );

  const cardsByDeck = await readCards(
    result.rows.map((row) => {
      return row.id;
    }),
  );

  return result.rows.map((row) => {
    return toDeck(row, cardsByDeck.get(row.id) ?? []);
  });
}

export async function getDeck(userId: string, deckId: string): Promise<Deck | undefined> {
  const result = await pool.query<DeckRow>(
    'SELECT id, title, created_at FROM decks WHERE id = $1 AND user_id = $2',
    [deckId, userId],
  );

  const row = result.rows[0];

  if (!row) {
    return undefined;
  }

  const cardsByDeck = await readCards([row.id]);

  return toDeck(row, cardsByDeck.get(row.id) ?? []);
}

export async function createDeck(
  userId: string,
  title: string,
  cards: CardInput[],
): Promise<Deck> {
  return withTransaction(async (client) => {
    const result = await client.query<DeckRow>(
      'INSERT INTO decks (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at',
      [userId, title],
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error('не удалось создать колоду');
    }

    return toDeck(row, await replaceCards(client, row.id, cards));
  });
}

export async function updateDeck(
  userId: string,
  deckId: string,
  title: string,
  cards: CardInput[],
): Promise<Deck | undefined> {
  return withTransaction(async (client) => {
    const result = await client.query<DeckRow>(
      'UPDATE decks SET title = $1 WHERE id = $2 AND user_id = $3 RETURNING id, title, created_at',
      [title, deckId, userId],
    );

    const row = result.rows[0];

    if (!row) {
      return undefined;
    }

    return toDeck(row, await replaceCards(client, row.id, cards));
  });
}

export async function deleteDeck(userId: string, deckId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM decks WHERE id = $1 AND user_id = $2', [
    deckId,
    userId,
  ]);

  return (result.rowCount ?? 0) > 0;
}
