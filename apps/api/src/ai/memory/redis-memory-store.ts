import type { Redis } from 'ioredis';
import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import { MemoryError } from '../errors/index.js';

// Redis-backed MemoryStore — takes an injected `Redis` client (e.g. the
// project's existing `redis` singleton from cache/redis.ts) rather than
// constructing its own connection, so it reuses the app's already-managed
// connection pool/lifecycle instead of opening a second one. Keys are
// namespaced under `ai:memory:` to avoid colliding with any other
// use of the same Redis instance (BullMQ-style job queues, rate
// limiting, etc.).
const KEY_PREFIX = 'ai:memory:';

export class RedisMemoryStore implements MemoryStore {
  constructor(private readonly redis: Redis) {}

  private key(key: string): string {
    return `${KEY_PREFIX}${key}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.key(key));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new MemoryError(
        `stored value for "${key}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        key,
      );
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await this.redis.set(this.key(key), serialized, 'EX', ttlSeconds);
    } else {
      await this.redis.set(this.key(key), serialized);
    }
  }

  async append<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const redisKey = this.key(key);
    await this.redis.rpush(redisKey, JSON.stringify(value));
    if (ttlSeconds) {
      await this.redis.expire(redisKey, ttlSeconds);
    }
  }

  async getList<T>(key: string): Promise<T[]> {
    const raw = await this.redis.lrange(this.key(key), 0, -1);
    return raw.map((item) => JSON.parse(item) as T);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.key(key));
  }
}
