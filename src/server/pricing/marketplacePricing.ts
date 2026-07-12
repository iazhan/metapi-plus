import type { EffectivePrice, PriceFieldKey } from './contracts.js';

export type MarketplaceGroupPricing = {
  quotaType: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheCreationPerMillion?: number;
  perCallTotal?: number;
};

function effectiveValue(
  price: EffectivePrice,
  field: PriceFieldKey,
  value: number | null,
): number | undefined {
  if (value === null) return undefined;
  return value * (price.priceSemantics[field] === 'price_includes_group_ratio' ? 1 : price.groupRatio);
}

export function toMarketplaceGroupPricing(price: EffectivePrice): MarketplaceGroupPricing {
  return {
    quotaType: price.perCallUsd !== null && price.inputPerMillionUsd === null && price.outputPerMillionUsd === null ? 1 : 0,
    inputPerMillion: effectiveValue(price, 'inputPerMillionUsd', price.inputPerMillionUsd),
    outputPerMillion: effectiveValue(price, 'outputPerMillionUsd', price.outputPerMillionUsd),
    cacheReadPerMillion: effectiveValue(price, 'cacheReadPerMillionUsd', price.cacheReadPerMillionUsd),
    cacheCreationPerMillion: effectiveValue(price, 'cacheWritePerMillionUsd', price.cacheWritePerMillionUsd),
    perCallTotal: effectiveValue(price, 'perCallUsd', price.perCallUsd),
  };
}
