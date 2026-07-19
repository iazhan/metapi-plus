import { describe, expect, it, vi } from 'vitest';
import type { EffectivePrice } from './contracts.js';
import { buildBillingSnapshot } from './billingSnapshotService.js';

function effectivePrice(overrides: Partial<EffectivePrice> = {}): EffectivePrice {
  return {
    upstreamModelId: 'gpt', providerId: 'openai', catalogModelId: 'gpt', mappingSource: 'exact',
    inputPerMillionUsd: 2, outputPerMillionUsd: 4, cacheReadPerMillionUsd: 1,
    cacheWritePerMillionUsd: null, reasoningPerMillionUsd: null,
    inputAudioPerMillionUsd: null, outputAudioPerMillionUsd: null, perCallUsd: null,
    priceSources: {
      inputPerMillionUsd: 'site', outputPerMillionUsd: 'models_dev', cacheReadPerMillionUsd: 'site',
      cacheWritePerMillionUsd: 'missing', reasoningPerMillionUsd: 'missing',
      inputAudioPerMillionUsd: 'missing', outputAudioPerMillionUsd: 'missing', perCallUsd: 'missing',
    },
    priceSemantics: {
      inputPerMillionUsd: 'price_includes_group_ratio', outputPerMillionUsd: 'base_price',
      cacheReadPerMillionUsd: 'base_price', cacheWritePerMillionUsd: 'base_price',
      reasoningPerMillionUsd: 'base_price', inputAudioPerMillionUsd: 'base_price',
      outputAudioPerMillionUsd: 'base_price', perCallUsd: 'base_price',
    },
    pricingSemantics: 'base_price', groupRatio: 2, groupRatioApplied: true,
    paidCny: 1, creditedUsd: 10,
    ...overrides,
  };
}

describe('billing snapshot service', () => {
  it('applies group ratio per field exactly once and converts USD to actual CNY', async () => {
    const snapshot = await buildBillingSnapshot({
      siteId: 1, accountId: 2, tokenGroup: 'default', upstreamModelId: 'gpt',
      promptTokens: 1_000_000, completionTokens: 500_000, cacheReadTokens: 100_000,
      promptTokensIncludeCache: true,
    }, {
      resolveEffectivePrice: vi.fn().mockResolvedValue(effectivePrice()),
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    });

    // Input excludes cache: 900k * $2 without ratio = 1.8; output: 500k * $4 * 2 = 4;
    // cache read: 100k * $1 * 2 = 0.2. Total USD 6, CNY 0.6.
    expect(snapshot).toMatchObject({
      siteCostUsd: 6,
      actualCostCny: 0.6,
      groupRatio: 2,
      groupRatioApplied: true,
      pricedAt: '2026-07-12T00:00:00.000Z',
    });
  });

  it('distinguishes a free model from an unpriced model', async () => {
    const free = effectivePrice({
      inputPerMillionUsd: 0,
      priceSources: { ...effectivePrice().priceSources, inputPerMillionUsd: 'manual' },
    });
    await expect(buildBillingSnapshot({
      siteId: 1, accountId: 2, tokenGroup: null, upstreamModelId: 'free', promptTokens: 10,
    }, { resolveEffectivePrice: vi.fn().mockResolvedValue(free) }))
      .resolves.toMatchObject({ siteCostUsd: 0, actualCostCny: 0 });

    const missing = effectivePrice({
      inputPerMillionUsd: null, outputPerMillionUsd: null, cacheReadPerMillionUsd: null,
      priceSources: Object.fromEntries(Object.keys(effectivePrice().priceSources).map((key) => [key, 'missing'])) as EffectivePrice['priceSources'],
    });
    await expect(buildBillingSnapshot({
      siteId: 1, accountId: 2, tokenGroup: null, upstreamModelId: 'missing', promptTokens: 10,
    }, { resolveEffectivePrice: vi.fn().mockResolvedValue(missing) })).resolves.toBeNull();
  });

  it('preserves cache usage and bills missing cache prices at the input rate', async () => {
    const snapshot = await buildBillingSnapshot({
      siteId: 1,
      accountId: 2,
      tokenGroup: 'default',
      upstreamModelId: 'gpt',
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheReadTokens: 600_000,
      cacheWriteTokens: 100_000,
      promptTokensIncludeCache: true,
    }, {
      resolveEffectivePrice: vi.fn().mockResolvedValue(effectivePrice({
        inputPerMillionUsd: 2,
        outputPerMillionUsd: 4,
        cacheReadPerMillionUsd: null,
        cacheWritePerMillionUsd: null,
      })),
    });

    expect(snapshot).toMatchObject({
      usage: {
        promptTokens: 1_000_000,
        completionTokens: 0,
        cacheReadTokens: 600_000,
        cacheWriteTokens: 100_000,
        billablePromptTokens: 300_000,
        promptTokensIncludeCache: true,
      },
      costBreakdownUsd: {
        input: 0.6,
        output: 0,
        cacheRead: 1.2,
        cacheWrite: 0.2,
      },
      cacheReadPriceFallback: true,
      cacheWritePriceFallback: true,
    });
    expect(snapshot?.siteCostUsd).toBeCloseTo(2, 10);
  });
});
