import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../pricing/priceRefreshScheduler.js', () => ({
  PRICE_REFRESH_DEFAULT_CRON: '0 0 * * *',
  PRICE_REFRESH_DEFAULT_ENABLED: true,
  getPriceRefreshTimeZone: () => 'Asia/Shanghai',
  triggerPriceRefresh: vi.fn(async () => ({ officialUpdated: true })),
  updatePriceRefreshScheduler: vi.fn(async () => undefined),
}));

describe('pricing routes', () => {
  let app: FastifyInstance;
  let db: typeof import('../../db/index.js').db;
  let schema: typeof import('../../db/index.js').schema;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-pricing-routes-'));
    await import('../../db/migrate.js');
    ({ db, schema } = await import('../../db/index.js'));
    const { pricingRoutes } = await import('./pricing.js');
    app = Fastify();
    await app.register(pricingRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accountGroupRateRules).run();
    await db.delete(schema.siteModelPriceRules).run();
    await db.delete(schema.siteModelPrices).run();
    await db.delete(schema.officialModelPrices).run();
    await db.delete(schema.sitePricingProfiles).run();
    await db.delete(schema.pricingRefreshStates).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.DATA_DIR;
  });

  it('roundtrips site profile and an encoded model rule', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site', url: 'https://site.example', platform: 'new-api', status: 'active',
    }).returning().get();
    const modelId = 'openai/gpt-4.1 mini/2025';

    const profile = await app.inject({
      method: 'PUT', url: `/api/sites/${site.id}/pricing/profile`,
      payload: { paidCny: 2, creditedUsd: 10 },
    });
    const rule = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}/pricing/models/${encodeURIComponent(modelId)}/rule`,
      payload: { mappingMode: 'custom', inputOverrideUsd: 0 },
    });
    const view = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/pricing` });

    expect(profile.statusCode).toBe(200);
    expect(rule.statusCode).toBe(200);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ profile: { paidCny: 2, creditedUsd: 10 } });
    expect(await db.select().from(schema.siteModelPriceRules).all()).toEqual([
      expect.objectContaining({ upstreamModelId: modelId, inputOverrideUsd: 0 }),
    ]);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/sites/${site.id}/pricing/models/${encodeURIComponent(modelId)}/rule`,
    });
    expect(removed.statusCode).toBe(200);
    expect(await db.select().from(schema.siteModelPriceRules).all()).toHaveLength(0);
  });

  it('roundtrips account group overrides including free groups', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site', url: 'https://site.example', platform: 'new-api', status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id, username: 'alice', accessToken: 'token', status: 'active',
    }).returning().get();
    const groupKey = 'pro/team';

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}/group-rates/${encodeURIComponent(groupKey)}/rule`,
      payload: { ratioOverride: 0 },
    });
    expect(saved.statusCode).toBe(200);
    expect(await db.select().from(schema.accountGroupRateRules).all()).toEqual([
      expect.objectContaining({ groupKey, ratioOverride: 0 }),
    ]);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/accounts/${account.id}/group-rates/${encodeURIComponent(groupKey)}/rule`,
    });
    expect(removed.statusCode).toBe(200);
  });

  it('returns resolver-owned effective prices and per-field sources', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'effective-site', url: 'https://effective.example', platform: 'new-api', status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id, username: 'alice', accessToken: 'token', status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    const now = new Date().toISOString();
    await db.insert(schema.siteModelPrices).values({
      siteId: site.id, upstreamModelId: 'gpt-site', inputPerMillionUsd: 2,
      pricingSemantics: 'base_price', fetchedAt: now,
    }).run();
    await db.insert(schema.siteModelPriceRules).values({
      siteId: site.id, upstreamModelId: 'gpt-site', mappingMode: 'custom', outputOverrideUsd: 0,
    }).run();
    await db.insert(schema.accountGroupRateRules).values({
      accountId: account.id, groupKey: 'default', ratioOverride: 1.5,
    }).run();

    const response = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/pricing` });
    expect(response.statusCode).toBe(200);
    expect(response.json().effectiveModels).toEqual([
      expect.objectContaining({
        upstreamModelId: 'gpt-site',
        inputPerMillionUsd: 2,
        outputPerMillionUsd: 0,
        groupRatio: 1.5,
        mappingSource: 'custom',
        priceSources: expect.objectContaining({
          inputPerMillionUsd: 'site',
          outputPerMillionUsd: 'manual',
        }),
      }),
    ]);
  });

  it('exposes only first-party catalog entries and rejects third-party mappings', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'catalog-site', url: 'https://catalog.example', platform: 'new-api', status: 'active',
    }).returning().get();
    await db.insert(schema.accounts).values({
      siteId: site.id, username: 'alice', accessToken: 'token', status: 'active',
    }).returning().get();
    const fetchedAt = '2026-07-12T00:00:00.000Z';
    await db.insert(schema.officialModelPrices).values([
      { providerId: 'openai', modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', inputPerMillionUsd: 5, fetchedAt },
      { providerId: 'openrouter', modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol via OpenRouter', inputPerMillionUsd: 4, fetchedAt },
    ]).run();

    const view = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/pricing` });
    expect(view.statusCode).toBe(200);
    expect(view.json().catalog).toEqual([
      expect.objectContaining({ providerId: 'openai', modelId: 'gpt-5.6-sol' }),
    ]);

    const rejected = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}/pricing/models/gpt-5.6-sol/rule`,
      payload: { mappingMode: 'manual', mappedProviderId: 'openrouter', mappedModelId: 'gpt-5.6-sol' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain('first-party provider');
  });

  it('persists validated refresh settings', async () => {
    const response = await app.inject({
      method: 'PUT', url: '/api/pricing/settings',
      payload: { enabled: false, cronExpr: '0 6 * * *' },
    });
    expect(response.statusCode).toBe(200);
    const settings = await app.inject({ method: 'GET', url: '/api/pricing/settings' });
    expect(settings.json()).toMatchObject({ enabled: false, cronExpr: '0 6 * * *' });
  });

  it('rejects non-canonical numeric resource ids', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sites/1suffix/pricing' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Invalid siteId' });
  });
});
