import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlatformAdapter } from '../services/platforms/base.js';

type DbModule = typeof import('../db/index.js');
type SourceModule = typeof import('./sitePriceSource.js');

describe('site price source', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let source: SourceModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-price-source-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    ({ db, schema } = await import('../db/index.js'));
    source = await import('./sitePriceSource.js');
  });

  beforeEach(async () => {
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('tries selected credentials without returning secret material', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'priced', url: 'https://priced.example.com', platform: 'new-api', status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'session-secret',
      apiToken: 'api-secret',
      status: 'active',
      extraConfig: JSON.stringify({ platformUserId: 42 }),
    }).returning().get();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'managed',
      token: 'managed-secret',
      enabled: true,
    }).run();
    const getPricing = vi.fn()
      .mockRejectedValueOnce(new Error('credential failed: session-secret'))
      .mockResolvedValueOnce([{
        upstreamModelId: 'gpt',
        inputPerMillionUsd: 1,
        outputPerMillionUsd: 2,
        pricingSemantics: 'base_price',
        rawMetadataJson: null,
      }]);
    const adapter = { getPricing } as unknown as PlatformAdapter;

    const rows = await source.fetchSitePrices(site.id, undefined, {
      getAdapter: () => adapter,
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    });

    expect(getPricing.mock.calls[0]?.[1]).toMatchObject({
      kind: 'session', value: 'session-secret', platformUserId: 42,
    });
    expect(getPricing.mock.calls[1]?.[1]).toMatchObject({ kind: 'api_key', value: 'api-secret' });
    expect(rows).toEqual([expect.objectContaining({
      upstreamModelId: 'gpt',
      fetchedAt: '2026-07-12T00:00:00.000Z',
    })]);
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('returns fixed failure kinds for unsupported platforms and failed credentials', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'unsupported', url: 'https://unsupported.example.com', platform: 'openai', status: 'active',
      apiKey: 'site-secret',
    }).returning().get();
    await expect(source.fetchSitePrices(site.id, undefined, {
      getAdapter: () => ({}) as PlatformAdapter,
    })).rejects.toMatchObject({ kind: 'unsupported', siteId: site.id });

    await expect(source.fetchSitePrices(site.id, undefined, {
      getAdapter: () => ({ getPricing: vi.fn().mockRejectedValue(new Error('site-secret leaked')) }) as unknown as PlatformAdapter,
    })).rejects.toMatchObject({ kind: 'upstream', siteId: site.id, message: 'site price fetch failed' });
  });

  it('classifies a successful but invalid quote response separately', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'invalid', url: 'https://invalid.example.com', platform: 'new-api', status: 'active', apiKey: 'key',
    }).returning().get();
    await expect(source.fetchSitePrices(site.id, undefined, {
      getAdapter: () => ({
        getPricing: vi.fn().mockResolvedValue([{ upstreamModelId: 'gpt', inputPerMillionUsd: -1 }]),
      }) as unknown as PlatformAdapter,
    })).rejects.toMatchObject({ kind: 'invalid_response', siteId: site.id });
  });

  it('propagates cancellation instead of trying another credential', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'abort', url: 'https://abort.example.com', platform: 'new-api', status: 'active', apiKey: 'key',
    }).returning().get();
    const controller = new AbortController();
    controller.abort();
    const getPricing = vi.fn();
    await expect(source.fetchSitePrices(site.id, controller.signal, {
      getAdapter: () => ({ getPricing }) as unknown as PlatformAdapter,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(getPricing).not.toHaveBeenCalled();
  });
});
