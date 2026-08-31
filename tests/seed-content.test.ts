import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const seedDir = fileURLToPath(new URL('../seed/', import.meta.url));

interface SeedCard {
  original: string;
  translation: string;
  transcription?: string;
}

interface SeedDeck {
  slug: string;
  title: string;
  description: string;
  language: string;
  topic: string;
  cards: SeedCard[];
}

const files = readdirSync(seedDir).filter((file) => {
  return file.endsWith('.json');
});

const decks: SeedDeck[] = files.map((file) => {
  return JSON.parse(readFileSync(join(seedDir, file), 'utf8')) as SeedDeck;
});

const TOPICS = new Set([
  'basics',
  'numbers',
  'food',
  'travel',
  'family',
  'work',
  'home',
  'health',
  'time',
  'verbs',
  'writing',
]);

const CYRILLIC = /[Ѐ-ӿ]/;

describe('seed content', () => {
  it('has one file per slug and no duplicates', () => {
    const slugs = decks.map((deck) => {
      return deck.slug;
    });

    assert.equal(new Set(slugs).size, slugs.length);

    for (const [index, file] of files.entries()) {
      assert.equal(`${decks[index]!.slug}.json`, file);
    }
  });

  it('keeps every deck at thirty cards or more', () => {
    for (const deck of decks) {
      assert.ok(
        deck.cards.length >= 30 && deck.cards.length <= 46,
        `${deck.slug} has ${deck.cards.length} cards`,
      );
    }
  });

  it('uses a known topic and a slug that matches it', () => {
    for (const deck of decks) {
      assert.ok(TOPICS.has(deck.topic), `${deck.slug} has topic ${deck.topic}`);

      if (deck.topic === 'writing') {
        continue;
      }

      const expected = deck.topic === 'basics' ? /^[a-z]+$/ : new RegExp(`^[a-z]+-${deck.topic}$`);

      assert.ok(expected.test(deck.slug), `${deck.slug} does not match its topic`);
    }
  });

  it('never repeats a word inside one language', () => {
    const seen = new Map<string, string>();

    for (const deck of decks) {
      if (deck.topic === 'writing') {
        continue;
      }

      for (const card of deck.cards) {
        const key = `${deck.language} ${card.original}`;
        const previous = seen.get(key);

        assert.equal(
          previous,
          undefined,
          `${card.original} appears in both ${previous} and ${deck.slug}`,
        );
        seen.set(key, deck.slug);
      }
    }
  });

  it('keeps one meaning per card and no commas', () => {
    for (const deck of decks) {
      for (const card of deck.cards) {
        assert.ok(!card.original.includes(','), `${deck.slug}: ${card.original}`);
        assert.ok(!card.translation.includes(','), `${deck.slug}: ${card.translation}`);
        assert.ok(card.original.trim().length > 0, `${deck.slug} has an empty word`);
        assert.ok(card.translation.trim().length > 0, `${deck.slug} has an empty translation`);
      }
    }
  });

  it('writes a description that is a finished sentence', () => {
    for (const deck of decks) {
      assert.ok(deck.description.length > 20, `${deck.slug} description is too short`);
      assert.ok(deck.description.endsWith('.'), `${deck.slug} description has no full stop`);
      assert.ok(deck.title.length > 0, `${deck.slug} has no title`);
    }
  });

  it('gives every Japanese and Korean card a reading', () => {
    for (const deck of decks) {
      if (deck.language !== 'ja' && deck.language !== 'ko') {
        continue;
      }

      if (deck.topic === 'writing') {
        continue;
      }

      for (const card of deck.cards) {
        assert.ok(
          card.transcription !== undefined && card.transcription.trim().length > 0,
          `${deck.slug}: ${card.original} has no reading`,
        );
      }
    }
  });

  it('has no Cyrillic anywhere', () => {
    for (const file of files) {
      const text = readFileSync(join(seedDir, file), 'utf8');

      assert.ok(!CYRILLIC.test(text), `${file} contains Cyrillic`);
    }
  });

  it('covers ten languages with ten topics each', () => {
    const matrix = new Map<string, Set<string>>();

    for (const deck of decks) {
      if (deck.topic === 'writing') {
        continue;
      }

      const topics = matrix.get(deck.language) ?? new Set<string>();

      topics.add(deck.topic);
      matrix.set(deck.language, topics);
    }

    assert.equal(matrix.size, 10);

    for (const [language, topics] of matrix) {
      assert.equal(topics.size, 10, `${language} has ${topics.size} topics`);
    }
  });
});
