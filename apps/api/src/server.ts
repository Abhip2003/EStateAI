import { config } from './config/env.js';
import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { authPlugin } from './plugins/auth.js';
import { prisma } from './db/prisma.js';
import { closeRedisConnection } from './cache/redis.js';

const app = Fastify({
  logger: true,
});

// Called directly (not via app.register) so the decorations attach to this
// root instance rather than a new encapsulated child context, making
// app.authenticate visible to the sibling route plugins registered below.
authPlugin(app);

await app.register(healthRoutes);
await app.register(authRoutes);

app.addHook('onClose', async () => {
  await prisma.$disconnect();
  await closeRedisConnection();
});

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start();
