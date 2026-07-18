import { Redis } from 'ioredis';
import { config } from '../config/env.js';

export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db,
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
