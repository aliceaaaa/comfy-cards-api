import type { PoolClient } from 'pg';
import { pool, withTransaction } from './pool.js';
import { Card, Deck } from '../types.js';

export interface CardInput {
  original: string;
  translation: string;
  transcription?: string;
}

export interface DeckRow {
  id: string;
  title: string;
  created_at: Date;
}

export interface CardRow {
  id: string;
  deck_id: string;
  original: string;
  translation: string;
  transcription: string | null;
}

export function toDeck(row: DeckRow, cards: Card[]): Deck {
  return {
    id: row.id,
    title: row.title,
    cards,
    createdAt: row.created_at.getTime(),
  };
}

export function toCard(row: CardRow): Card {
  const card: Card = {
    id: row.id,
    original: row.original,
    translation: row.translation,
  };

  if (row.transcription !== null) {
    card.transcription = row.transcription;
  }

  return card;
}

function toStoredTranscription(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';

  if (trimmed.length === 0) {
    return null;
  }

  return trimmed;
}

async function readCards(deckIds: string[]): Promise<Map<string, Card[]>> {
  const byDeck = new Map<string, Card[]>();

  if (deckIds.length === 0) {
    return byDeck;
  }

  const result = await pool.query<CardRow>(
    `SELECT id, deck_id, original, translation, transcription
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
  const transcriptions = cards.map((card) => {
    return toStoredTranscription(card.transcription);
  });
  const positions = cards.map((card, index) => {
    return index;
  });

  const result = await client.query<CardRow & { position: number }>(
    `INSERT INTO cards (deck_id, original, translation, transcription, position)
     SELECT $1, original, translation, transcription, position
     FROM unnest($2::text[], $3::text[], $4::text[], $5::int[])
       AS input (original, translation, transcription, position)
     RETURNING id, deck_id, original, translation, transcription, position`,
    [deckId, originals, translations, transcriptions, positions],
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
      throw new Error('deck was not created');
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
