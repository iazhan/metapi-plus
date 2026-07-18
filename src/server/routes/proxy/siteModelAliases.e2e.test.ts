import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');
type ConfigModule = typeof import('../../config.js');

describe('site model aliases through the proxy boundary', () => {
  let app: FastifyInstance;
  let upstream: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let previousProxyToken = '';
  let previousGlobalAllowedModels: string[] = [];
  let previousGlobalBlockedBrands: string[] = [];
  let dataDir = '';
  const upstreamBodies: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-model-alias-proxy-'));
    process.env.DATA_DIR = dataDir;

    upstream = Fastify();
    upstream.post('/v1/completions', async (request) => {
      upstreamBodies.push(request.body as Record<string, unknown>);
      return {
        id: 'cmpl-site-alias-e2e',
        object: 'text_completion',
        model: 'source-model',
        choices: [{ text: 'ok', index: 0, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 500_000,
          total_tokens: 1_500_000,
        },
      };
    });
    await upstream.listen({ host: '127.0.0.1', port: 0 });

    await import('../../db/migrate.js');
    ({ db, schema } = await import('../../db/index.js'));
    const [{ proxyRoutes }, configModule, routeWorkflow] = await Promise.all([
      import('./router.js'),
      import('../../config.js'),
      import('../../services/routeRefreshWorkflow.js'),
    ]);
    config = configModule.config;
    previousProxyToken = config.proxyToken;
    previousGlobalAllowedModels = [...config.globalAllowedModels];
    previousGlobalBlockedBrands = [...config.globalBlockedBrands];
    config.proxyToken = 'sk-site-model-alias-e2e';
    config.globalAllowedModels = [];
    config.globalBlockedBrands = [];

    const address = upstream.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Local upstream did not expose a TCP address');
    }
    const upstreamBaseUrl = `http://127.0.0.1:${address.port}`;

    const site = await db.insert(schema.sites).values({
      name: 'site-alias-proxy-upstream',
      url: upstreamBaseUrl,
      platform: 'openai',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'site-alias-proxy-user',
      accessToken: '',
      apiToken: 'sk-local-upstream',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'source-model',
      available: true,
    }).run();
    await db.insert(schema.siteModelPrices).values([
      {
        siteId: site.id,
        upstreamModelId: 'source-model',
        inputPerMillionUsd: 2,
        outputPerMillionUsd: 4,
        pricingSemantics: 'base_price',
        fetchedAt: '2026-07-15T00:00:00.000Z',
      },
      {
        siteId: site.id,
        upstreamModelId: 'team-alias',
        inputPerMillionUsd: 200,
        outputPerMillionUsd: 400,
        pricingSemantics: 'base_price',
        fetchedAt: '2026-07-15T00:00:00.000Z',
      },
    ]).run();
    await routeWorkflow.replaceSiteModelAliasesAndRebuildRoutes(site.id, [
      { sourceModel: 'source-model', aliasModel: 'team-alias' },
    ]);

    app = Fastify();
    await app.register(proxyRoutes);
  });

  afterAll(async () => {
    config.proxyToken = previousProxyToken;
    config.globalAllowedModels = previousGlobalAllowedModels;
    config.globalBlockedBrands = previousGlobalBlockedBrands;
    await app?.close();
    await upstream?.close();
    delete process.env.DATA_DIR;
  });

  it('exposes aliases while dispatching, logging, and billing against the source model', async () => {
    const authorization = 'Bearer sk-site-model-alias-e2e';
    const modelsResponse = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization },
    });

    expect(modelsResponse.statusCode).toBe(200);
    const modelIds = (modelsResponse.json() as { data: Array<{ id: string }> })
      .data
      .map((model) => model.id);
    expect(modelIds).toEqual(expect.arrayContaining(['source-model', 'team-alias']));

    const completionResponse = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: { authorization },
      payload: {
        model: 'team-alias',
        prompt: 'Use the stable public model name.',
      },
    });

    expect(completionResponse.statusCode).toBe(200);
    expect(upstreamBodies).toHaveLength(1);
    expect(upstreamBodies[0]).toMatchObject({ model: 'source-model' });

    await vi.waitFor(async () => {
      expect(await db.select().from(schema.proxyLogs).all()).toHaveLength(1);
    });
    const proxyLog = await db.select().from(schema.proxyLogs).get();
    expect(proxyLog).toMatchObject({
      modelRequested: 'team-alias',
      modelActual: 'source-model',
      status: 'success',
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      totalTokens: 1_500_000,
      estimatedCost: 4,
    });
    expect(JSON.parse(proxyLog!.billingDetails!)).toMatchObject({
      upstreamModelId: 'source-model',
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 4,
      siteCostUsd: 4,
      actualCostCny: 4,
    });
  });
});
