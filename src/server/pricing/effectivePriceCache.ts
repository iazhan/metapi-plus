import type { EffectivePrice } from './contracts.js';

export const EFFECTIVE_PRICE_CACHE_TTL_MS = 60_000;

const cache = new Map<string, { expiresAt: number; value: Promise<EffectivePrice> }>();
const invalidationListeners = new Set<(input?: { siteId?: number; accountId?: number }) => void>();

export function registerEffectivePriceCacheInvalidationListener(
  listener: (input?: { siteId?: number; accountId?: number }) => void,
): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

export function getEffectivePriceCacheEntry(key: string, now = Date.now()): Promise<EffectivePrice> | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setEffectivePriceCacheEntry(
  key: string,
  value: Promise<EffectivePrice>,
  now = Date.now(),
): void {
  cache.set(key, { expiresAt: now + EFFECTIVE_PRICE_CACHE_TTL_MS, value });
}

export function deleteEffectivePriceCacheEntry(key: string): void {
  cache.delete(key);
}

export function invalidateEffectivePriceCacheEntries(input?: { siteId?: number; accountId?: number }): void {
  for (const listener of invalidationListeners) listener(input);
  if (!input?.siteId && !input?.accountId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    const [siteId, accountId] = key.split('\0').map(Number);
    if (input.siteId && siteId !== input.siteId) continue;
    if (input.accountId && accountId !== input.accountId) continue;
    cache.delete(key);
  }
}
