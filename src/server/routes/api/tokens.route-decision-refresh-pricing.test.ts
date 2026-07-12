import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

type DbModule = typeof import('../../db/index.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');
type PriceRefreshServiceModule = typeof import('../../pricing/priceRefreshService.js');
type ConfigModule = typeof import('../../config.js');

const { fetchMock, withSiteProxyRequestInitMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  withSiteProxyRequestInitMock: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('../../services/siteProxy.js', () => ({
  withSiteProxyRequestInit: (...args: unknown[]) => withSiteProxyRequestInitMock(...args),
}));

function buildPricingPayload(modelName: string, modelRatio: number) {
  return {
    data: [{
      model_name: modelName,
      quota_type: 0,
      model_ratio: modelRatio,
      completion_ratio: 1,
      enable_groups: ['default'],
    }],
    group_ratio: { default: 1 },
  };
}

describe('POST /api/routes/decision/batch refreshPricingCatalog', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let refreshSitePriceSnapshot: PriceRefreshServiceModule['refreshSitePriceSnapshot'];
  let config: ConfigModule['config'];
  let originalRoutingWeights: typeof config.routingWeights;
  let originalRoutingFallbackUnitCost: number;
  let dataDir = '';
  let pricingPhase: 'old' | 'new' = 'old';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-route-decision-refresh-pricing-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    const priceRefreshServiceModule = await import('../../pricing/priceRefreshService.js');
    const configModule = await import('../../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    refreshSitePriceSnapshot = priceRefreshServiceModule.refreshSitePriceSnapshot;
    config = configModule.config;
    originalRoutingWeights = { ...config.routingWeights };
    originalRoutingFallbackUnitCost = config.routingFallbackUnitCost;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    pricingPhase = 'old';
    fetchMock.mockReset();
    withSiteProxyRequestInitMock.mockReset();
    withSiteProxyRequestInitMock.mockImplementation(async (_url: string, init: Record<string, unknown>) => init);
    fetchMock.mockImplementation(async (url: string | URL) => {
      const normalizedUrl = String(url);
      let payload: ReturnType<typeof buildPricingPayload> | null = null;
      if (normalizedUrl.includes('pricing-a.example.com')) {
        payload = buildPricingPayload('gpt-4o-mini', pricingPhase === 'old' ? 0.1 : 10);
      } else if (normalizedUrl.includes('pricing-b.example.com')) {
        payload = buildPricingPayload('gpt-4o-mini', pricingPhase === 'old' ? 10 : 0.1);
      }

      if (!payload) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 404,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    });

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();

    config.routingWeights = {
      baseWeightFactor: 0.35,
      valueScoreFactor: 0.65,
      costWeight: 1,
      balanceWeight: 0,
      usageWeight: 0,
    };
    config.routingFallbackUnitCost = 100;
  });

  afterAll(async () => {
    await app.close();
    config.routingWeights = { ...originalRoutingWeights };
    config.routingFallbackUnitCost = originalRoutingFallbackUnitCost;
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  it('forces pricing catalog refresh before recomputing exact-route probabilities', async () => {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    const siteA = await db.insert(schema.sites).values({
      name: 'site-a',
      url: 'https://pricing-a.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const siteB = await db.insert(schema.sites).values({
      name: 'site-b',
      url: 'https://pricing-b.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: siteA.id,
      username: 'user-a',
      accessToken: 'access-a',
      apiToken: 'api-a',
      status: 'active',
    }).returning().get();

    const accountB = await db.insert(schema.accounts).values({
      siteId: siteB.id,
      username: 'user-b',
      accessToken: 'access-b',
      apiToken: 'api-b',
      status: 'active',
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: route.id,
        accountId: accountA.id,
        tokenId: null,
        priority: 0,
        weight: 10,
        enabled: true,
      },
      {
        routeId: route.id,
        accountId: accountB.id,
        tokenId: null,
        priority: 0,
        weight: 10,
        enabled: true,
      },
    ]).run();

    await refreshSitePriceSnapshot(siteA.id);
    await refreshSitePriceSnapshot(siteB.id);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    pricingPhase = 'new';

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes/decision/batch',
      payload: {
        models: ['gpt-4o-mini'],
        refreshPricingCatalog: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      decisions: Record<string, {
        matched: boolean;
        candidates: Array<{ siteName: string; probability: number; reason: string }>;
      }>;
    };
    expect(body.success).toBe(true);

    const decision = body.decisions['gpt-4o-mini'];
    expect(decision?.matched).toBe(true);

    const candidateA = decision?.candidates.find((candidate) => candidate.siteName === 'site-a');
    const candidateB = decision?.candidates.find((candidate) => candidate.siteName === 'site-b');

    expect(candidateA).toBeTruthy();
    expect(candidateB).toBeTruthy();
    expect(candidateB?.probability || 0).toBeGreaterThan(candidateA?.probability || 0);
    expect(candidateA?.reason || '').toContain('成本=价格域');
    expect(candidateB?.reason || '').toContain('成本=价格域');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
