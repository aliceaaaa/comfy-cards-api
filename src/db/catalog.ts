import { pool, withTransaction } from './pool.js';
import { CardRow, DeckRow, toCard, toDeck } from './decks.js';
import { Card, CatalogDeck, CatalogDeckSummary, Deck } from '../types.js';

export interface CatalogFilters {
  language?: string;
  topic?: string;
  q?: string;
  limit: number;
  offset: number;
}

interface SummaryRow {
  slug: string;
  title: string;
  description: string | null;
  language: string | null;
  topic: string | null;
  card_count: number;
}

interface CatalogDeckRow extends DeckRow {
  slug: string;
  description: string | null;
  language: string | null;
  topic: string | null;
}

const PUBLIC_FILTER = `d.is_public
    AND d.slug IS NOT NULL
    AND ($1::text IS NULL OR d.language = $1)
    AND ($2::text IS NULL OR d.topic = $2)
    AND ($3::text IS NULL OR d.title ILIKE '%' || $3 || '%' OR d.description ILIKE '%' || $3 || '%')`;

function toSummary(row: SummaryRow): CatalogDeckSummary {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    language: row.language,
    topic: row.topic,
    cardCount: row.card_count,
  };
}

export async function listCatalog(
  filters: CatalogFilters,
): Promise<{ decks: CatalogDeckSummary[]; total: number }> {
  const conditions = [filters.language ?? null, filters.topic ?? null, filters.q ?? null];

  const decks = await pool.query<SummaryRow>(
    `SELECT d.slug, d.title, d.description, d.language, d.topic, COUNT(c.id)::int AS card_count
     FROM decks d
     LEFT JOIN cards c ON c.deck_id = d.id
     WHERE ${PUBLIC_FILTER}
     GROUP BY d.id
     ORDER BY d.language, d.title
     LIMIT $4 OFFSET $5`,
    [...conditions, filters.limit, filters.offset],
  );

  const total = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM decks d WHERE ${PUBLIC_FILTER}`,
    conditions,
  );

  return {
    decks: decks.rows.map(toSummary),
    total: total.rows[0]?.count ?? 0,
  };
}

export async function getCatalogDeck(slug: string): Promise<CatalogDeck | undefined> {
  const result = await pool.query<CatalogDeckRow>(
    `SELECT id, title, created_at, slug, description, language, topic
     FROM decks
     WHERE slug = $1 AND is_public`,
    [slug],
  );

  const row = result.rows[0];

  if (!row) {
    return undefined;
  }

  const cards = await pool.query<CardRow>(
    `SELECT id, deck_id, original, translation, transcription
     FROM cards
     WHERE deck_id = $1
     ORDER BY position`,
    [row.id],
  );

  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    language: row.language,
    topic: row.topic,
    cardCount: cards.rowCount ?? 0,
    cards: cards.rows.map(toCard),
  };
}

export async function copyCatalogDeck(
  userId: string,
  slug: string,
): Promise<Deck | undefined> {
  return withTransaction(async (client) => {
    const created = await client.query<DeckRow>(
      `INSERT INTO decks (user_id, title, description, language, topic)
       SELECT $1, source.title, source.description, source.language, source.topic
       FROM decks source
       WHERE source.slug = $2 AND source.is_public
       RETURNING id, title, created_at`,
      [userId, slug],
    );

    const row = created.rows[0];

    if (!row) {
      return undefined;
    }

    await client.query(
      `INSERT INTO cards (deck_id, original, translation, transcription, position)
       SELECT $1, c.original, c.translation, c.transcription, c.position
       FROM cards c
       JOIN decks source ON source.id = c.deck_id
       WHERE source.slug = $2 AND source.is_public`,
      [row.id, slug],
    );

    const cards = await client.query<CardRow>(
      `SELECT id, deck_id, original, translation, transcription
       FROM cards
       WHERE deck_id = $1
       ORDER BY position`,
      [row.id],
    );

    const copied = cards.rows.map(toCard);

    return toDeck(row, copied, copied.length);
  });
}

export async function exportCatalog(): Promise<CatalogDeck[]> {
  const decks = await pool.query<CatalogDeckRow>(
    `SELECT id, title, created_at, slug, description, language, topic
     FROM decks
     WHERE is_public AND slug IS NOT NULL
     ORDER BY language, title`,
  );

  if (decks.rows.length === 0) {
    return [];
  }

  const cards = await pool.query<CardRow>(
    `SELECT id, deck_id, original, translation, transcription
     FROM cards
     WHERE deck_id = ANY ($1::uuid[])
     ORDER BY deck_id, position`,
    [
      decks.rows.map((row) => {
        return row.id;
      }),
    ],
  );

  const byDeck = new Map<string, Card[]>();

  for (const row of cards.rows) {
    const list = byDeck.get(row.deck_id) ?? [];

    list.push(toCard(row));
    byDeck.set(row.deck_id, list);
  }

  return decks.rows.map((row) => {
    const deckCards = byDeck.get(row.id) ?? [];

    return {
      slug: row.slug,
      title: row.title,
      description: row.description,
      language: row.language,
      topic: row.topic,
      cardCount: deckCards.length,
      cards: deckCards,
    };
  });
}
