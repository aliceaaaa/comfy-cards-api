import { migrate } from './db/migrate.js';
import { env } from './lib/env.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  await migrate();

  const app = await buildServer();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
