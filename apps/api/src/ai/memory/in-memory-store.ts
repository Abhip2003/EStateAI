import type { MemoryStore } from '../interfaces/memory-store.interface.js';

interface Entry {
  value: unknown;
  expiresAt?: number;
}

// Process-local MemoryStore — the default for short-term/single-process
// use (tests, single-instance dev, anything that doesn't need to survive
// a restart or be shared across instances). Swap in RedisMemoryStore for
// anything that must persist or be shared.
export class InMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, Entry>();

  private isExpired(entry: Entry): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }

  get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry || this.isExpired(entry)) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
    return Promise.resolve();
  }

  async append<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const list = (await this.getList<T>(key)) ?? [];
    list.push(value);
    await this.set(key, list, ttlSeconds);
  }

  async getList<T>(key: string): Promise<T[]> {
    const value = await this.get<T[]>(key);
    return value ?? [];
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}
