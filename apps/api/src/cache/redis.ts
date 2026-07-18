import { Redis } from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB = Number(process.env.REDIS_DB ?? 0);

export const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  db: REDIS_DB,
  retryStrategy: (attempt: number) => Math.min(attempt * 100, 3000),
  reconnectOnError: () => true,
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => {
  console.log('[redis] connected');
});

redis.on('close', () => {
  console.log('[redis] disconnected');
});

redis.on('error', (err) => {
  console.error('[redis] error:', err.message);
});

const HEALTH_CHECK_TIMEOUT_MS = 3000;

export async function checkRedisConnection(): Promise<boolean> {
  const ping = redis.ping();
  // Prevent an unhandled rejection if the timeout below wins the race.
  ping.catch(() => undefined);

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('Redis health check timed out')), HEALTH_CHECK_TIMEOUT_MS);
  });

  try {
    const pong = await Promise.race([ping, timeout]);
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedisConnection(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
