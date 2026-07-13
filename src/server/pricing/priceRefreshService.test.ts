import { describe, expect, it, vi } from 'vitest';
import { runPriceRefreshPass } from './priceRefreshService.js';

describe('price refresh service', () => {
  it('refreshes official prices before sites and caps site concurrency at three', async () => {
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const fetchSitePrices = vi.fn(async (siteId: number) => {
      order.push(`site:${siteId}`);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return [{ upstreamModelId: `m${siteId}`, pricingSemantics: 'base_price' as const, fetchedAt: '2026-07-12T00:00:00.000Z' }];
    });
    const pass = runPriceRefreshPass({}, {
      fetchModelsDevPrices: async () => {
        order.push('official:fetch');
        return [{ providerId: 'p', modelId: 'm', displayName: 'M', fetchedAt: '2026-07-12T00:00:00.000Z' }];
      },
      replaceOfficialPriceSnapshot: async () => { order.push('official:replace'); },
      listEnabledSiteIds: async () => [1, 2, 3, 4, 5],
      fetchSitePrices,
      replaceSitePriceSnapshot: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    });

    await vi.waitFor(() => expect(fetchSitePrices).toHaveBeenCalledTimes(3));
    expect(order.slice(0, 2)).toEqual(['official:fetch', 'official:replace']);
    expect(peak).toBe(3);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(fetchSitePrices).toHaveBeenCalledTimes(5));
    releases.splice(0).forEach((release) => release());
    await expect(pass).resolves.toMatchObject({ officialRefreshed: true, siteRefreshed: 5, siteFailed: 0 });
  });

  it('isolates one site failure and records only fixed failure metadata', async () => {
    const recordFailure = vi.fn();
    const recordPassResult = vi.fn();
    const result = await runPriceRefreshPass({}, {
      fetchModelsDevPrices: async () => [{ providerId: 'p', modelId: 'm', displayName: 'M', fetchedAt: '2026-07-12T00:00:00.000Z' }],
      replaceOfficialPriceSnapshot: vi.fn(),
      listEnabledSiteIds: async () => [1, 2],
      fetchSitePrices: async (siteId) => {
        if (siteId === 1) throw new Error('Authorization: Bearer secret full response');
        return [];
      },
      replaceSitePriceSnapshot: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure,
      recordPassResult,
    });
    expect(result).toMatchObject({ siteRefreshed: 1, siteFailed: 1 });
    expect(recordFailure).toHaveBeenCalledWith('site', 1, 'upstream');
    expect(recordPassResult).toHaveBeenCalledWith(expect.objectContaining({
      officialRefreshed: true,
      siteRefreshed: 1,
      siteFailed: 1,
    }));
    expect(JSON.stringify(recordFailure.mock.calls)).not.toContain('secret');
  });

  it('stops before site refresh when the official catalog fails', async () => {
    const listEnabledSiteIds = vi.fn();
    const recordPassResult = vi.fn();
    await expect(runPriceRefreshPass({}, {
      fetchModelsDevPrices: async () => { throw new Error('network'); },
      replaceOfficialPriceSnapshot: vi.fn(),
      listEnabledSiteIds,
      fetchSitePrices: vi.fn(),
      replaceSitePriceSnapshot: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordPassResult,
    })).rejects.toThrow('official price refresh failed');
    expect(listEnabledSiteIds).not.toHaveBeenCalled();
    expect(recordPassResult).toHaveBeenCalledWith(expect.objectContaining({ officialRefreshed: false }));
  });

  it('classifies snapshot persistence failures as storage errors', async () => {
    const recordFailure = vi.fn();
    const result = await runPriceRefreshPass({}, {
      fetchModelsDevPrices: async () => [{ providerId: 'p', modelId: 'm', displayName: 'M', fetchedAt: '2026-07-12T00:00:00.000Z' }],
      replaceOfficialPriceSnapshot: vi.fn(),
      listEnabledSiteIds: async () => [1],
      fetchSitePrices: async () => [],
      replaceSitePriceSnapshot: async () => { throw new Error('database write failed'); },
      recordSuccess: vi.fn(),
      recordFailure,
    });

    expect(result).toMatchObject({ siteRefreshed: 0, siteFailed: 1 });
    expect(recordFailure).toHaveBeenCalledWith('site', 1, 'storage');
  });

  it('classifies official snapshot persistence failures as storage errors', async () => {
    const recordFailure = vi.fn();
    await expect(runPriceRefreshPass({}, {
      fetchModelsDevPrices: async () => [{ providerId: 'p', modelId: 'm', displayName: 'M', fetchedAt: '2026-07-12T00:00:00.000Z' }],
      replaceOfficialPriceSnapshot: async () => { throw new Error('database write failed'); },
      listEnabledSiteIds: vi.fn(),
      fetchSitePrices: vi.fn(),
      replaceSitePriceSnapshot: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure,
    })).rejects.toThrow('official price refresh failed');

    expect(recordFailure).toHaveBeenCalledWith('official', 0, 'storage');
  });
});
