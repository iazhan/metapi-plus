import { describe, expect, it } from 'vitest';
import { resolveCatalogMapping, type CatalogModelIdentity } from './siteModelMappingService.js';

const catalog: CatalogModelIdentity[] = [
  { providerId: 'openai', modelId: 'gpt-4.1-mini' },
  { providerId: 'anthropic', modelId: 'claude-sonnet-4' },
  { providerId: 'gateway', modelId: 'shared-model' },
  { providerId: 'other', modelId: 'shared-model' },
];

describe('site model mapping', () => {
  it('prefers a manual mapping over automatic candidates', () => {
    expect(resolveCatalogMapping({
      upstreamModelId: 'gpt-4.1-mini',
      providerHint: 'openai',
      catalog,
      rule: {
        mappingMode: 'manual',
        mappedProviderId: 'anthropic',
        mappedModelId: 'claude-sonnet-4',
      },
    })).toEqual({
      status: 'mapped',
      source: 'manual',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
    });
  });

  it('matches exact provider/model and provider-prefixed IDs', () => {
    expect(resolveCatalogMapping({
      upstreamModelId: 'gpt-4.1-mini',
      providerHint: 'openai',
      catalog,
    })).toMatchObject({ status: 'mapped', source: 'exact', providerId: 'openai' });
    expect(resolveCatalogMapping({
      upstreamModelId: 'anthropic/claude-sonnet-4',
      catalog,
    })).toMatchObject({ status: 'mapped', source: 'exact', providerId: 'anthropic' });
  });

  it('prefers the first-party provider over third-party catalog quotes', () => {
    expect(resolveCatalogMapping({
      upstreamModelId: 'gpt-5.6-sol',
      catalog: [
        { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        { providerId: 'openrouter', modelId: 'gpt-5.6-sol' },
        { providerId: 'azure', modelId: 'gpt-5.6-sol' },
      ],
    })).toEqual({
      status: 'mapped',
      source: 'exact',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
    });
  });

  it('rejects manual mappings to non-first-party providers', () => {
    expect(resolveCatalogMapping({
      upstreamModelId: 'gpt-5.6-sol',
      catalog,
      rule: {
        mappingMode: 'manual',
        mappedProviderId: 'openrouter',
        mappedModelId: 'gpt-5.6-sol',
      },
    })).toEqual({ status: 'unmapped' });
  });

  it('does not treat hosted Bedrock prices as model-owner prices', () => {
    const catalogWithHostedQuote: CatalogModelIdentity[] = [
      { providerId: 'amazon-bedrock', modelId: 'claude-sonnet-4-5' },
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
    ];
    expect(resolveCatalogMapping({
      upstreamModelId: 'claude-sonnet-4-5',
      catalog: catalogWithHostedQuote,
    })).toMatchObject({ status: 'mapped', providerId: 'anthropic' });
    expect(resolveCatalogMapping({
      upstreamModelId: 'claude-sonnet-4-5',
      catalog: catalogWithHostedQuote.slice(0, 1),
    })).toEqual({ status: 'unmapped' });
  });

  it.each([
    ['grok-4', 'xai', 'openrouter'],
    ['gemini-2.5-pro', 'google', 'google-vertex'],
  ])('uses the model owner for %s instead of a hosted quote', (modelId, ownerProviderId, hostedProviderId) => {
    expect(resolveCatalogMapping({
      upstreamModelId: modelId,
      catalog: [
        { providerId: hostedProviderId, modelId },
        { providerId: ownerProviderId, modelId },
      ],
    })).toMatchObject({
      status: 'mapped',
      providerId: ownerProviderId,
      modelId,
    });
  });

  it('allows only a controlled YYYY-MM-DD suffix with one verified candidate', () => {
    expect(resolveCatalogMapping({
      upstreamModelId: 'gpt-4.1-mini-2025-04-14',
      providerHint: 'openai',
      catalog,
    })).toEqual({
      status: 'mapped',
      source: 'date_suffix',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
    });
    expect(resolveCatalogMapping({
      upstreamModelId: 'shared-model-2025-04-14',
      catalog,
    })).toEqual({ status: 'unmapped' });
  });

  it('never fuzzy-matches or guesses ambiguous providers', () => {
    expect(resolveCatalogMapping({ upstreamModelId: 'gpt-4', catalog })).toEqual({ status: 'unmapped' });
    expect(resolveCatalogMapping({ upstreamModelId: 'shared-model', catalog })).toEqual({ status: 'unmapped' });
  });

  it('honors custom mode without an official mapping', () => {
    expect(resolveCatalogMapping({
      upstreamModelId: 'gpt-4.1-mini',
      providerHint: 'openai',
      catalog,
      rule: { mappingMode: 'custom', mappedProviderId: null, mappedModelId: null },
    })).toEqual({ status: 'custom' });
  });
});
