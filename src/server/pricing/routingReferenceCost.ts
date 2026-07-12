import { getCredentialModeFromExtraConfig } from '../services/accountExtraConfig.js';
import { resolveEffectivePrice } from './effectivePriceResolver.js';
import { registerEffectivePriceCacheInvalidationListener } from './effectivePriceCache.js';

const REFERENCE_TOKENS_PER_SIDE = 500_000;
const costs = new Map<string, number>();

function key(input: { siteId: number; accountId: number; modelName: string }): string {
  return `${input.siteId}:${input.accountId}:${input.modelName.trim().toLowerCase()}`;
}

export function getCachedPricingDomainRoutingReferenceCost(input: {
  siteId: number;
  accountId: number;
  modelName: string;
}): number | null {
  return costs.get(key(input)) ?? null;
}

export async function refreshPricingDomainRoutingReferenceCost(input: {
  siteId: number;
  accountId: number;
  accountExtraConfig?: string | null;
  tokenGroup?: string | null;
  modelName: string;
}): Promise<number | null> {
  const credentialKind = getCredentialModeFromExtraConfig(input.accountExtraConfig) === 'apikey'
    ? 'api_key' as const
    : 'session' as const;
  const effective = await resolveEffectivePrice({
    siteId: input.siteId,
    accountId: input.accountId,
    credentialKind,
    tokenGroup: credentialKind === 'api_key' ? 'default' : (input.tokenGroup ?? null),
    upstreamModelId: input.modelName,
  });
  const priceParts = [
    ['inputPerMillionUsd', effective.inputPerMillionUsd],
    ['outputPerMillionUsd', effective.outputPerMillionUsd],
  ] as const;
  let referenceCost = 0;
  let hasPrice = false;
  for (const [field, price] of priceParts) {
    if (price === null) continue;
    hasPrice = true;
    const ratio = effective.priceSemantics[field] === 'price_includes_group_ratio'
      ? 1
      : effective.groupRatio;
    referenceCost += price * ratio * REFERENCE_TOKENS_PER_SIDE / 1_000_000;
  }
  const cacheKey = key(input);
  if (!hasPrice) {
    costs.delete(cacheKey);
    return null;
  }
  costs.set(cacheKey, referenceCost);
  return referenceCost;
}

export function invalidatePricingDomainRoutingReferenceCosts(input?: { siteId?: number; accountId?: number }): void {
  if (input?.siteId === undefined && input?.accountId === undefined) {
    costs.clear();
    return;
  }
  for (const cacheKey of costs.keys()) {
    const [siteId, accountId] = cacheKey.split(':').map(Number);
    if (input.siteId !== undefined && siteId !== input.siteId) continue;
    if (input.accountId !== undefined && accountId !== input.accountId) continue;
    costs.delete(cacheKey);
  }
}

registerEffectivePriceCacheInvalidationListener(invalidatePricingDomainRoutingReferenceCosts);
