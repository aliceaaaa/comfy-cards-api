import { z } from 'zod';
import { badRequest } from './http-error.js';

/** Разбирает вход по схеме и превращает ошибки zod в понятный ответ 400. */
export function parseInput<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    const message = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.');

        if (path.length === 0) {
          return issue.message;
        }

        return `${path}: ${issue.message}`;
      })
      .join('; ');

    throw badRequest(message);
  }

  return result.data;
}
