import { pool, withTransaction } from './pool.js';
import { toCard } from './decks.js';
import { nextReview } from '../lib/scheduler.js';
import { Card } from '../types.js';

export interface CardReview {
  cardId: string;
  box: number;
  intervalDays: number;
  dueAt: number;
  correctCount: number;
  wrongCount: number;
}

export interface DueCard extends Card {
  box: number;
  dueAt: number | null;
}

export interface DueCardWithDeck extends DueCard {
  deckId: string;
  deckTitle: string;
}

interface ReviewRow {
  card_id: string;
  box: number;
  interval_days: number;
  due_at: Date;
  correct_count: number;
  wrong_count: number;
}

interface DueRow {
  id: string;
  deck_id: string;
  original: string;
  translation: string;
  transcription: string | null;
  box: number;
  due_at: Date | null;
}

interface DueRowWithDeck extends DueRow {
  deck_title: string;
}

const DUE_CONDITION = '(r.due_at IS NULL OR r.due_at <= now())';

function toReview(row: ReviewRow): CardReview {
  return {
    cardId: row.card_id,
    box: row.box,
    intervalDays: row.interval_days,
    dueAt: row.due_at.getTime(),
    correctCount: row.correct_count,
    wrongCount: row.wrong_count,
  };
}

export async function recordReview(
  userId: string,
  cardId: string,
  isCorrect: boolean,
): Promise<CardReview | undefined> {
  return withTransaction(async (client) => {
    const current = await client.query<{ box: number | null }>(
      `SELECT r.box
       FROM cards c
       JOIN decks d ON d.id = c.deck_id
       LEFT JOIN card_reviews r ON r.card_id = c.id AND r.user_id = $1
       WHERE c.id = $2 AND d.user_id = $1`,
      [userId, cardId],
    );

    const row = current.rows[0];

    if (!row) {
      return undefined;
    }

    const scheduled = nextReview(row.box ?? 0, isCorrect, new Date());

    const saved = await client.query<ReviewRow>(
      `INSERT INTO card_reviews
         (user_id, card_id, box, interval_days, due_at, last_reviewed_at, correct_count, wrong_count)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7)
       ON CONFLICT (user_id, card_id) DO UPDATE SET
         box = EXCLUDED.box,
         interval_days = EXCLUDED.interval_days,
         due_at = EXCLUDED.due_at,
         last_reviewed_at = now(),
         correct_count = card_reviews.correct_count + EXCLUDED.correct_count,
         wrong_count = card_reviews.wrong_count + EXCLUDED.wrong_count
       RETURNING card_id, box, interval_days, due_at, correct_count, wrong_count`,
      [
        userId,
        cardId,
        scheduled.box,
        scheduled.intervalDays,
        scheduled.dueAt,
        isCorrect ? 1 : 0,
        isCorrect ? 0 : 1,
      ],
    );

    const savedRow = saved.rows[0];

    if (!savedRow) {
      throw new Error('review was not written');
    }

    return toReview(savedRow);
  });
}

export async function ownsDeck(userId: string, deckId: string): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM decks WHERE id = $1 AND user_id = $2', [
    deckId,
    userId,
  ]);

  return (result.rowCount ?? 0) > 0;
}

export async function listDueCards(userId: string, deckId: string): Promise<DueCard[]> {
  const result = await pool.query<DueRow>(
    `SELECT c.id, c.deck_id, c.original, c.translation, c.transcription,
            COALESCE(r.box, 0) AS box, r.due_at
     FROM cards c
     JOIN decks d ON d.id = c.deck_id
     LEFT JOIN card_reviews r ON r.card_id = c.id AND r.user_id = $1
     WHERE d.id = $2 AND d.user_id = $1 AND ${DUE_CONDITION}
     ORDER BY r.due_at NULLS LAST, c.position`,
    [userId, deckId],
  );

  return result.rows.map((row) => {
    return {
      ...toCard(row),
      box: row.box,
      dueAt: row.due_at === null ? null : row.due_at.getTime(),
    };
  });
}

export async function listAllDueCards(
  userId: string,
  limit: number,
): Promise<{ cards: DueCardWithDeck[]; total: number }> {
  const cards = await pool.query<DueRowWithDeck>(
    `SELECT c.id, c.deck_id, c.original, c.translation, c.transcription,
            COALESCE(r.box, 0) AS box, r.due_at, d.title AS deck_title
     FROM cards c
     JOIN decks d ON d.id = c.deck_id
     LEFT JOIN card_reviews r ON r.card_id = c.id AND r.user_id = $1
     WHERE d.user_id = $1 AND ${DUE_CONDITION}
     ORDER BY r.due_at NULLS LAST, d.created_at DESC, c.position
     LIMIT $2`,
    [userId, limit],
  );

  const total = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM cards c
     JOIN decks d ON d.id = c.deck_id
     LEFT JOIN card_reviews r ON r.card_id = c.id AND r.user_id = $1
     WHERE d.user_id = $1 AND ${DUE_CONDITION}`,
    [userId],
  );

  return {
    cards: cards.rows.map((row) => {
      return {
        ...toCard(row),
        box: row.box,
        dueAt: row.due_at === null ? null : row.due_at.getTime(),
        deckId: row.deck_id,
        deckTitle: row.deck_title,
      };
    }),
    total: total.rows[0]?.count ?? 0,
  };
}
