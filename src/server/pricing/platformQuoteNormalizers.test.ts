import { describe, expect, it } from 'vitest';
import {
  normalizeNewApiPricingPayload,
  normalizeOneHubPricingPayload,
} from './platformQuoteNormalizers.js';

describe('platform quote normalizers', () => {
  it('converts new-api model ratios to absolute per-million USD prices', () => {
    const quotes = normalizeNewApiPricingPayload({
      data: [{
        model_name: 'gpt-ratio',
        quota_type: 0,
        model_ratio: 0.5,
        completion_ratio: 2,
        cache_ratio: 0.25,
        cache_creation_ratio: 1.25,
      }],
    });
    expect(quotes).toEqual([{
      upstreamModelId: 'gpt-ratio',
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 2,
      cacheReadPerMillionUsd: 0.25,
      cacheWritePerMillionUsd: 1.25,
      reasoningPerMillionUsd: null,
      inputAudioPerMillionUsd: null,
      outputAudioPerMillionUsd: null,
      perCallUsd: null,
      pricingSemantics: 'model_ratio',
      rawMetadataJson: JSON.stringify({ basis: 'new_api_quota_500000_per_usd', quotaType: 0 }),
    }]);
  });

  it('normalizes one-hub token and per-call prices without group multiplication', () => {
    const tokenQuotes = normalizeOneHubPricingPayload({
      data: {
        'claude-token': {
          price: { type: 'tokens', input: 3, output: 15, input_cache_read: 0.3 },
        },
      },
    });
    expect(tokenQuotes[0]).toMatchObject({
      upstreamModelId: 'claude-token',
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
      cacheReadPerMillionUsd: 0.3,
      pricingSemantics: 'base_price',
    });

    const callQuotes = normalizeOneHubPricingPayload({
      data: { image: { price: { type: 'times', input: 2 } } },
    });
    expect(callQuotes[0]).toMatchObject({
      upstreamModelId: 'image',
      perCallUsd: 0.004,
      pricingSemantics: 'model_ratio',
    });
  });

  it('rejects unknown semantics and invalid numbers as a complete payload', () => {
    expect(() => normalizeOneHubPricingPayload({
      data: { bad: { price: { type: 'mystery', input: 1 } } },
    })).toThrow(/unsupported pricing type/i);
    expect(() => normalizeNewApiPricingPayload({
      data: [{ model_name: 'bad', quota_type: 0, model_ratio: Number.NaN }],
    })).toThrow(/invalid/i);
  });
});
