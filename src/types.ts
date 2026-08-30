export interface Card {
  id: string;
  original: string;
  translation: string;
  transcription?: string;
}

export interface Deck {
  id: string;
  title: string;
  cards: Card[];
  createdAt: number;
  dueCount: number;
}

export type CardSide = 'original' | 'translation';

export interface PublicUser {
  id: string;
  email: string;
}

export interface CatalogDeckSummary {
  slug: string;
  title: string;
  description: string | null;
  language: string | null;
  topic: string | null;
  cardCount: number;
}

export interface CatalogDeck extends CatalogDeckSummary {
  cards: Card[];
}
