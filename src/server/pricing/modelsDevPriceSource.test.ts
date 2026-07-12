import { describe, expect, it } from 'vitest';
import { parseModelsDevPayload } from './modelsDevPriceSource.js';

describe('models.dev price source', () => {
  it('normalizes official prices, free fields, missing fields, and tier metadata', () => {
    const rows = parseModelsDevPayload({
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-4.1-mini': {
            id: 'gpt-4.1-mini',
            name: 'GPT-4.1 Mini',
            last_updated: '2025-04-14',
            cost: {
              input: 0.4,
              output: 1.6,
              cache_read: 0,
              tiers: [{ context: 200000, input: 0.8, output: 3.2 }],
              context_over_200k: { input: 0.8, output: 3.2 },
            },
          },
        },
      },
    }, '2026-07-12T00:00:00.000Z');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      displayName: 'GPT-4.1 Mini',
      inputPerMillionUsd: 0.4,
      outputPerMillionUsd: 1.6,
      cacheReadPerMillionUsd: 0,
      cacheWritePerMillionUsd: null,
      sourceUpdatedAt: '2025-04-14',
      fetchedAt: '2026-07-12T00:00:00.000Z',
    });
    expect(JSON.parse(rows[0]!.tiersJson!)).toEqual({
      tiers: [{ context: 200000, input: 0.8, output: 3.2 }],
      contextOver200k: { input: 0.8, output: 3.2 },
    });
  });

  it('rejects an invalid record instead of returning a partial catalog', () => {
    expect(() => parseModelsDevPayload({
      openai: {
        id: 'openai',
        models: {
          valid: { id: 'valid', name: 'Valid', cost: { input: 1 } },
          invalid: { id: 'invalid', name: 'Invalid', cost: { input: -1 } },
        },
      },
    }, '2026-07-12T00:00:00.000Z')).toThrow(/invalid models\.dev/i);
  });

  it('rejects empty and structurally invalid catalogs', () => {
    expect(() => parseModelsDevPayload({}, '2026-07-12T00:00:00.000Z')).toThrow(/empty/i);
    expect(() => parseModelsDevPayload([], '2026-07-12T00:00:00.000Z')).toThrow(/record|object/i);
  });
});
