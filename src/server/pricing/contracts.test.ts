import { describe, expect, it } from 'vitest';
import {
  accountGroupRateRuleInputSchema,
  pricingProfileInputSchema,
  siteModelPriceRuleInputSchema,
  sitePriceInputSchema,
} from './contracts.js';

describe('pricing contracts', () => {
  it('accepts free prices and nullable inherited overrides', () => {
    expect(sitePriceInputSchema.parse({
      upstreamModelId: 'gpt-free',
      pricingSemantics: 'base_price',
      inputPerMillionUsd: 0,
      outputPerMillionUsd: null,
      fetchedAt: '2026-07-12T00:00:00.000Z',
    }).inputPerMillionUsd).toBe(0);
    expect(siteModelPriceRuleInputSchema.parse({
      mappingMode: 'custom',
      inputOverrideUsd: 0,
      outputOverrideUsd: null,
    }).inputOverrideUsd).toBe(0);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid price %s',
    (value) => {
      expect(sitePriceInputSchema.safeParse({
        upstreamModelId: 'gpt-invalid',
        pricingSemantics: 'base_price',
        inputPerMillionUsd: value,
        fetchedAt: '2026-07-12T00:00:00.000Z',
      }).success).toBe(false);
    },
  );

  it('enforces manual and custom mapping shapes', () => {
    expect(siteModelPriceRuleInputSchema.safeParse({
      mappingMode: 'manual',
      mappedProviderId: 'openai',
      mappedModelId: 'gpt-4.1-mini',
    }).success).toBe(true);
    expect(siteModelPriceRuleInputSchema.safeParse({
      mappingMode: 'manual',
      mappedProviderId: 'openai',
    }).success).toBe(false);
    expect(siteModelPriceRuleInputSchema.safeParse({
      mappingMode: 'custom',
      mappedProviderId: 'openai',
      mappedModelId: 'gpt-4.1-mini',
    }).success).toBe(false);
    expect(siteModelPriceRuleInputSchema.safeParse({
      mappingMode: 'manual',
      mappedProviderId: 'openrouter',
      mappedModelId: 'gpt-4.1-mini',
    }).success).toBe(false);
  });

  it('requires finite positive recharge amounts and finite non-negative ratios', () => {
    expect(pricingProfileInputSchema.parse({ paidCny: 1, creditedUsd: 10 }))
      .toEqual({ paidCny: 1, creditedUsd: 10 });
    expect(pricingProfileInputSchema.safeParse({ paidCny: 0, creditedUsd: 10 }).success).toBe(false);
    expect(pricingProfileInputSchema.safeParse({ paidCny: 1, creditedUsd: Infinity }).success).toBe(false);
    expect(accountGroupRateRuleInputSchema.parse({ ratioOverride: 0 }).ratioOverride).toBe(0);
    expect(accountGroupRateRuleInputSchema.safeParse({ ratioOverride: -0.1 }).success).toBe(false);
  });
});
