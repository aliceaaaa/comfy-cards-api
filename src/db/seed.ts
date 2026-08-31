import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { pool, withTransaction } from './pool.js';
import { migrate } from './migrate.js';

const seedDir = fileURLToPath(new URL('../../seed/', import.meta.url));

export const CATALOG_OWNER_EMAIL = 'catalog@comfy-cards.local';
const UNUSABLE_PASSWORD_HASH = '-';

const seedDeckSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  language: z.string().trim().min(1).max(20),
  topic: z.string().trim().min(1).max(40),
  cards: z
    .array(
      z.object({
        original: z.string().trim().min(1).max(200),
        translation: z.string().trim().min(1).max(200),
        transcription: z.string().trim().max(200).optional(),
      }),
    )
    .min(1),
});

type SeedDeck = z.infer<typeof seedDeckSchema>;

export async function ensureCatalogOwner(): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [CATALOG_OWNER_EMAIL, UNUSABLE_PASSWORD_HASH],
  );

  const insertedRow = inserted.rows[0];

  if (insertedRow) {
    return insertedRow.id;
  }

  const existing = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    CATALOG_OWNER_EMAIL,
  ]);

  const existingRow = existing.rows[0];

  if (!existingRow) {
    throw new Error('catalog owner is missing after upsert');
  }

  return existingRow.id;
}

export async function upsertCatalogDeck(ownerId: string, deck: SeedDeck): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO decks (user_id, title, description, language, topic, slug, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (slug) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         language = EXCLUDED.language,
         topic = EXCLUDED.topic,
         is_public = true
       RETURNING id`,
      [ownerId, deck.title, deck.description ?? null, deck.language, deck.topic, deck.slug],
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(`deck ${deck.slug} was not written`);
    }

    await client.query('DELETE FROM cards WHERE deck_id = $1', [row.id]);

    const originals = deck.cards.map((card) => {
      return card.original;
    });
    const translations = deck.cards.map((card) => {
      return card.translation;
    });
    const transcriptions = deck.cards.map((card) => {
      const value = card.transcription?.trim() ?? '';

      if (value.length === 0) {
        return null;
      }

      return value;
    });
    const positions = deck.cards.map((card, index) => {
      return index;
    });

    await client.query(
      `INSERT INTO cards (deck_id, original, translation, transcription, position)
       SELECT $1, original, translation, transcription, position
       FROM unnest($2::text[], $3::text[], $4::text[], $5::int[])
         AS input (original, translation, transcription, position)`,
      [row.id, originals, translations, transcriptions, positions],
    );
  });
}

export async function readSeedDecks(): Promise<SeedDeck[]> {
  const files = (await readdir(seedDir))
    .filter((file) => {
      return file.endsWith('.json');
    })
    .sort();

  const decks: SeedDeck[] = [];

  for (const file of files) {
    const raw = await readFile(join(seedDir, file), 'utf8');
    const parsed = seedDeckSchema.safeParse(JSON.parse(raw));

    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => {
          return `${issue.path.join('.')}: ${issue.message}`;
        })
        .join('; ');

      throw new Error(`${file} is invalid: ${details}`);
    }

    decks.push(parsed.data);
  }

  return decks;
}

export async function seed(): Promise<void> {
  await migrate();

  const ownerId = await ensureCatalogOwner();
  const decks = await readSeedDecks();

  for (const deck of decks) {
    await upsertCatalogDeck(ownerId, deck);
    console.log(`catalog deck ready: ${deck.slug} (${deck.cards.length} cards)`);
  }

  await warnAboutOrphanSlugs(decks);
}

async function warnAboutOrphanSlugs(decks: SeedDeck[]): Promise<void> {
  const known = decks.map((deck) => {
    return deck.slug;
  });

  const orphans = await pool.query<{ slug: string }>(
    `SELECT slug FROM decks
     WHERE is_public AND slug IS NOT NULL AND NOT (slug = ANY ($1::text[]))
     ORDER BY slug`,
    [known],
  );

  if (orphans.rowCount === 0) {
    return;
  }

  const slugs = orphans.rows.map((row) => {
    return row.slug;
  });

  console.warn(
    `public decks with no seed file, left untouched: ${slugs.join(', ')}. A slug is a public address: keep it or the indexed page breaks.`,
  );
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  seed()
    .then(() => {
      return pool.end();
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
