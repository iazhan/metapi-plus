import { describe, expect, it } from 'vitest';
import { toMarketplaceGroupPricing } from './marketplacePricing.js';

describe('pricing-domain marketplace presentation', () => {
  it('applies group ratio once and preserves free fields', () => {
    const result = toMarketplaceGroupPricing({
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 0,
      cacheReadPerMillionUsd: null,
      cacheWritePerMillionUsd: null,
      reasoningPerMillionUsd: null,
      inputAudioPerMillionUsd: null,
      outputAudioPerMillionUsd: null,
      perCallUsd: 2,
      upstreamModelId: 'model',
      providerId: 'provider',
      catalogModelId: 'model',
      mappingSource: 'exact',
      priceSources: {
        inputPerMillionUsd: 'site', outputPerMillionUsd: 'manual',
        cacheReadPerMillionUsd: 'missing', cacheWritePerMillionUsd: 'missing',
        reasoningPerMillionUsd: 'missing', inputAudioPerMillionUsd: 'missing',
        outputAudioPerMillionUsd: 'missing', perCallUsd: 'site',
      },
      priceSemantics: {
        inputPerMillionUsd: 'base_price', outputPerMillionUsd: 'base_price',
        cacheReadPerMillionUsd: 'base_price', cacheWritePerMillionUsd: 'base_price',
        reasoningPerMillionUsd: 'base_price', inputAudioPerMillionUsd: 'base_price',
        outputAudioPerMillionUsd: 'base_price', perCallUsd: 'price_includes_group_ratio',
      },
      pricingSemantics: 'base_price',
      groupRatio: 1.5,
      groupRatioApplied: true,
      paidCny: 1,
      creditedUsd: 1,
    });
    expect(result).toEqual({
      quotaType: 0,
      inputPerMillion: 1.5,
      outputPerMillion: 0,
      perCallTotal: 2,
    });
  });
});
