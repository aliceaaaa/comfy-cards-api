import { z } from 'zod';
import { badRequest } from './http-error.js';

export function parseInput<Schema extends z.ZodTypeAny>(
  schema: Schema,
  data: unknown,
): z.output<Schema> {
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
