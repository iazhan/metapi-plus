import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildBillingSnapshotMock = vi.fn();

vi.mock('../pricing/billingSnapshotService.js', () => ({
  buildBillingSnapshot: (...args: unknown[]) => buildBillingSnapshotMock(...args),
}));

import { resolvePerCallProxyBilling, resolveProxyLogBilling } from './proxyBilling.js';

describe('resolveProxyLogBilling', () => {
  beforeEach(() => buildBillingSnapshotMock.mockReset());

  it('builds one immutable pricing snapshot and preserves both cost currencies', async () => {
    buildBillingSnapshotMock.mockResolvedValue({
      currency: 'CNY',
      priceSources: {},
      providerId: 'anthropic',
      catalogModelId: 'claude-haiku-4-5',
      upstreamModelId: 'claude-haiku-4-5-20251001',
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 5,
      cacheReadPerMillionUsd: 0.1,
      cacheWritePerMillionUsd: 1.25,
      reasoningPerMillionUsd: null,
      inputAudioPerMillionUsd: null,
      outputAudioPerMillionUsd: null,
      perCallUsd: null,
      groupRatio: 1,
      groupRatioApplied: true,
      paidCny: 1,
      creditedUsd: 10,
      siteCostUsd: 0.083057,
      actualCostCny: 0.0083057,
      pricedAt: '2026-07-12T00:00:00.000Z',
    });

    const result = await resolveProxyLogBilling({
      site: { id: 1, url: 'https://site.example', platform: 'new-api' },
      account: { id: 2, extraConfig: JSON.stringify({ credentialMode: 'session' }) },
      tokenGroup: 'pro',
      modelName: 'claude-haiku-4-5-20251001',
      parsedUsage: {
        promptTokens: 146638, completionTokens: 172, totalTokens: 146810,
        cacheReadTokens: 0, cacheCreationTokens: 0, promptTokensIncludeCache: null,
      },
      resolvedUsage: {
        promptTokens: 146638, completionTokens: 172, totalTokens: 146810,
        recoveredFromSelfLog: true, estimatedCostFromQuota: 999,
        selfLogBillingMeta: {
          modelRatio: 2.5, completionRatio: 5, cacheRatio: 0.1,
          cacheCreationRatio: 1.25, groupRatio: 9,
          cacheReadTokens: 145692, cacheCreationTokens: 945,
          promptTokensIncludeCache: true,
        },
      },
    });

    expect(buildBillingSnapshotMock).toHaveBeenCalledTimes(1);
    expect(buildBillingSnapshotMock).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 1,
      accountId: 2,
      tokenGroup: 'pro',
      upstreamModelId: 'claude-haiku-4-5-20251001',
      cacheReadTokens: 145692,
      cacheWriteTokens: 945,
      promptTokensIncludeCache: true,
    }));
    expect(result).toMatchObject({
      estimatedCost: 0.083057,
      actualCostCny: 0.0083057,
      billingDetails: { actualCostCny: 0.0083057 },
    });
  });

  it('does not fabricate CNY cost when the pricing domain cannot price a request', async () => {
    buildBillingSnapshotMock.mockResolvedValue(null);
    const result = await resolveProxyLogBilling({
      site: { id: 1, url: 'https://site.example', platform: 'new-api' },
      account: { id: 2 },
      modelName: 'unknown',
      parsedUsage: {
        promptTokens: 1, completionTokens: 1, totalTokens: 2,
        cacheReadTokens: 0, cacheCreationTokens: 0, promptTokensIncludeCache: null,
      },
      resolvedUsage: {
        promptTokens: 1, completionTokens: 1, totalTokens: 2,
        recoveredFromSelfLog: true, estimatedCostFromQuota: 12,
        selfLogBillingMeta: null,
      },
    });
    expect(result).toEqual({ estimatedCost: 0, actualCostCny: 0, billingDetails: null });
  });

  it('prices non-token proxy requests through the same immutable snapshot service', async () => {
    buildBillingSnapshotMock.mockResolvedValue({
      siteCostUsd: 0.04,
      actualCostCny: 0.02,
      perCallUsd: 0.04,
    });
    const result = await resolvePerCallProxyBilling({
      site: { id: 1, url: 'https://site.example', platform: 'new-api' },
      account: { id: 2, extraConfig: JSON.stringify({ credentialMode: 'apikey' }) },
      tokenGroup: 'vip',
      modelName: 'gpt-image-1',
    });
    expect(buildBillingSnapshotMock).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 1,
      accountId: 2,
      credentialKind: 'api_key',
      tokenGroup: 'default',
      upstreamModelId: 'gpt-image-1',
      promptTokens: 0,
      completionTokens: 0,
    }));
    expect(result).toMatchObject({
      estimatedCost: 0.04,
      actualCostCny: 0.02,
      billingDetails: { perCallUsd: 0.04 },
    });
  });
});
