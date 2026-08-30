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

function cardKey(original: string, translation: string, transcription: string | null): string {
  return [original, translation, transcription ?? ''].join('\u0000');
}

async function syncCards(
  client: PoolClient,
  deckId: string,
  cards: CardInput[],
): Promise<Card[]> {
  const existing = await client.query<CardRow>(
    `SELECT id, deck_id, original, translation, transcription
     FROM cards
     WHERE deck_id = $1
     ORDER BY position`,
    [deckId],
  );

  const reusableIds = new Map<string, string[]>();

  for (const row of existing.rows) {
    const key = cardKey(row.original, row.translation, row.transcription);
    const ids = reusableIds.get(key) ?? [];

    ids.push(row.id);
    reusableIds.set(key, ids);
  }

  const result: Card[] = new Array(cards.length);
  const keptIds: string[] = [];
  const keptPositions: number[] = [];
  const insertedCards: CardInput[] = [];
  const insertedPositions: number[] = [];

  cards.forEach((card, position) => {
    const transcription = toStoredTranscription(card.transcription);
    const key = cardKey(card.original, card.translation, transcription);
    const reusedId = reusableIds.get(key)?.shift();

    if (reusedId === undefined) {
      insertedCards.push(card);
      insertedPositions.push(position);
      return;
    }

    keptIds.push(reusedId);
    keptPositions.push(position);
    result[position] = toCard({
      id: reusedId,
      deck_id: deckId,
      original: card.original,
      translation: card.translation,
      transcription,
    });
  });

  const staleIds = Array.from(reusableIds.values()).flat();

  if (staleIds.length > 0) {
    await client.query('DELETE FROM cards WHERE id = ANY ($1::uuid[])', [staleIds]);
  }

  if (keptIds.length > 0) {
    await client.query(
      `UPDATE cards SET position = input.position
       FROM unnest($1::uuid[], $2::int[]) AS input (id, position)
       WHERE cards.id = input.id`,
      [keptIds, keptPositions],
    );
  }

  if (insertedCards.length > 0) {
    const inserted = await client.query<CardRow & { position: number }>(
      `INSERT INTO cards (deck_id, original, translation, transcription, position)
       SELECT $1, original, translation, transcription, position
       FROM unnest($2::text[], $3::text[], $4::text[], $5::int[])
         AS input (original, translation, transcription, position)
       RETURNING id, deck_id, original, translation, transcription, position`,
      [
        deckId,
        insertedCards.map((card) => {
          return card.original;
        }),
        insertedCards.map((card) => {
          return card.translation;
        }),
        insertedCards.map((card) => {
          return toStoredTranscription(card.transcription);
        }),
        insertedPositions,
      ],
    );

    for (const row of inserted.rows) {
      result[row.position] = toCard(row);
    }
  }

  return result;
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

    return toDeck(row, await syncCards(client, row.id, cards));
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

    return toDeck(row, await syncCards(client, row.id, cards));
  });
}

export async function deleteDeck(userId: string, deckId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM decks WHERE id = $1 AND user_id = $2', [
    deckId,
    userId,
  ]);

  return (result.rowCount ?? 0) > 0;
}
