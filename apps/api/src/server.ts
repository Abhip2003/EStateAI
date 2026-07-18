import 'dotenv/config';
import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';
import { prisma } from './db/prisma.js';
import { closeRedisConnection } from './cache/redis.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = Fastify({
  logger: true,
});

await app.register(healthRoutes);

app.addHook('onClose', async () => {
  await prisma.$disconnect();
  await closeRedisConnection();
});

async function start(): Promise<void> {
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start();
