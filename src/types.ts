/** Формы данных повторяют src/types.ts во фронтенде, чтобы ответы API ложились без адаптеров. */
export interface Card {
  id: string;
  original: string;
  translation: string;
}

export interface Deck {
  id: string;
  title: string;
  cards: Card[];
  createdAt: number;
}

export interface PublicUser {
  id: string;
  email: string;
}
