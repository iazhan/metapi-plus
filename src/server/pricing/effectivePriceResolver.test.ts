import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type RepositoryModule = typeof import('./pricingRepository.js');
type ResolverModule = typeof import('./effectivePriceResolver.js');

describe('effective price resolver', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let repository: RepositoryModule;
  let resolver: ResolverModule;
  let dataDir = '';
  let siteId = 0;
  let accountId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-effective-price-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    ({ db, schema } = await import('../db/index.js'));
    repository = await import('./pricingRepository.js');
    resolver = await import('./effectivePriceResolver.js');
  });

  beforeEach(async () => {
    await db.delete(schema.accountGroupRateRules).run();
    await db.delete(schema.accountGroupRates).run();
    await db.delete(schema.siteModelPriceRules).run();
    await db.delete(schema.siteModelPrices).run();
    await db.delete(schema.officialModelPrices).run();
    await db.delete(schema.sitePricingProfiles).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'site', url: 'https://site.example.com', platform: 'new-api', status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id, accessToken: 'session', status: 'active',
    }).returning().get();
    siteId = site.id;
    accountId = account.id;
    resolver.invalidateEffectivePriceCache();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('resolves every field independently and preserves a free override', async () => {
    await repository.replaceOfficialPriceSnapshot([{
      providerId: 'openai', modelId: 'gpt', displayName: 'GPT',
      inputPerMillionUsd: 1, outputPerMillionUsd: 4, cacheReadPerMillionUsd: 0.5,
      fetchedAt: '2026-07-12T00:00:00.000Z',
    }]);
    await repository.replaceSitePriceSnapshot(siteId, [{
      upstreamModelId: 'gpt', inputPerMillionUsd: 2, outputPerMillionUsd: 3,
      pricingSemantics: 'base_price', fetchedAt: '2026-07-12T00:00:00.000Z',
    }]);
    await repository.upsertSiteModelPriceRule(siteId, 'gpt', {
      mappingMode: 'manual', mappedProviderId: 'openai', mappedModelId: 'gpt',
      inputOverrideUsd: 0,
    });

    const result = await resolver.resolveEffectivePrice({
      siteId, accountId, tokenGroup: 'vip', upstreamModelId: 'gpt', providerHint: 'openai',
    });

    expect(result).toMatchObject({
      inputPerMillionUsd: 0,
      outputPerMillionUsd: 3,
      cacheReadPerMillionUsd: 0.5,
      reasoningPerMillionUsd: null,
      providerId: 'openai',
      catalogModelId: 'gpt',
      mappingSource: 'manual',
    });
    expect(result.priceSources).toMatchObject({
      inputPerMillionUsd: 'manual',
      outputPerMillionUsd: 'site',
      cacheReadPerMillionUsd: 'models_dev',
      reasoningPerMillionUsd: 'missing',
    });
  });

  it('uses only the first-party catalog quote when third-party quotes share the model id', async () => {
    await repository.replaceOfficialPriceSnapshot([
      {
        providerId: 'openai', modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol',
        inputPerMillionUsd: 5, outputPerMillionUsd: 30,
        fetchedAt: '2026-07-12T00:00:00.000Z',
      },
      {
        providerId: 'openrouter', modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol via OpenRouter',
        inputPerMillionUsd: 4, outputPerMillionUsd: 24,
        fetchedAt: '2026-07-12T00:00:00.000Z',
      },
    ]);

    const result = await resolver.resolveEffectivePrice({
      siteId, accountId, tokenGroup: null, upstreamModelId: 'gpt-5.6-sol',
    });

    expect(result).toMatchObject({
      providerId: 'openai',
      catalogModelId: 'gpt-5.6-sol',
      mappingSource: 'exact',
      inputPerMillionUsd: 5,
      outputPerMillionUsd: 30,
    });
  });

  it('uses manual group rate before synchronized rate and restores inheritance on delete', async () => {
    await db.insert(schema.accountGroupRates).values({
      accountId, groupKey: 'vip', groupName: 'VIP', ratio: 1.5,
      lastSyncedAt: '2026-07-12T00:00:00.000Z',
    }).run();
    await repository.upsertAccountGroupRateRule(accountId, 'vip', 0);
    expect(await resolver.resolveEffectiveGroupRate(accountId, 'vip')).toEqual({
      synchronizedRatio: 1.5, overrideRatio: 0, effectiveRatio: 0,
    });
    await repository.deleteAccountGroupRateRule(accountId, 'vip');
    expect(await resolver.resolveEffectiveGroupRate(accountId, 'vip')).toEqual({
      synchronizedRatio: 1.5, overrideRatio: null, effectiveRatio: 1.5,
    });
    expect(await resolver.resolveEffectiveGroupRate(accountId, 'missing')).toEqual({
      synchronizedRatio: null, overrideRatio: null, effectiveRatio: 1,
    });
  });

  it('uses default group for API keys and marks custom models without catalog fallback', async () => {
    await repository.replaceOfficialPriceSnapshot([{
      providerId: 'openai', modelId: 'custom', displayName: 'Catalog', inputPerMillionUsd: 9,
      fetchedAt: '2026-07-12T00:00:00.000Z',
    }]);
    await repository.upsertSiteModelPriceRule(siteId, 'custom', {
      mappingMode: 'custom', outputOverrideUsd: 2,
    });
    await repository.upsertAccountGroupRateRule(accountId, 'default', 1.25);
    const result = await resolver.resolveEffectivePrice({
      siteId, accountId, tokenGroup: 'vip', credentialKind: 'api_key', upstreamModelId: 'custom',
    });
    expect(result.mappingSource).toBe('custom');
    expect(result.inputPerMillionUsd).toBeNull();
    expect(result.outputPerMillionUsd).toBe(2);
    expect(result.groupRatio).toBe(1.25);
  });

  it('records site fields that already include group ratio without affecting inherited fields', async () => {
    await repository.replaceOfficialPriceSnapshot([{
      providerId: 'openai', modelId: 'mixed', displayName: 'Mixed', cacheReadPerMillionUsd: 1,
      fetchedAt: '2026-07-12T00:00:00.000Z',
    }]);
    await repository.replaceSitePriceSnapshot(siteId, [{
      upstreamModelId: 'mixed', inputPerMillionUsd: 2,
      pricingSemantics: 'price_includes_group_ratio', fetchedAt: '2026-07-12T00:00:00.000Z',
    }]);
    await repository.upsertAccountGroupRateRule(accountId, 'default', 2);
    const result = await resolver.resolveEffectivePrice({
      siteId, accountId, tokenGroup: null, upstreamModelId: 'mixed', providerHint: 'openai',
    });
    expect(result.priceSemantics.inputPerMillionUsd).toBe('price_includes_group_ratio');
    expect(result.priceSemantics.cacheReadPerMillionUsd).toBe('base_price');
  });

  it('invalidates cached prices when repository-owned snapshots or rules change', async () => {
    await repository.replaceSitePriceSnapshot(siteId, [{
      upstreamModelId: 'cached', inputPerMillionUsd: 1,
      pricingSemantics: 'base_price', fetchedAt: '2026-07-12T00:00:00.000Z',
    }]);
    const input = { siteId, accountId, tokenGroup: null, upstreamModelId: 'cached' };
    expect((await resolver.resolveEffectivePrice(input)).inputPerMillionUsd).toBe(1);

    await repository.replaceSitePriceSnapshot(siteId, [{
      upstreamModelId: 'cached', inputPerMillionUsd: 2,
      pricingSemantics: 'base_price', fetchedAt: '2026-07-12T01:00:00.000Z',
    }]);
    expect((await resolver.resolveEffectivePrice(input)).inputPerMillionUsd).toBe(2);

    await repository.upsertSiteModelPriceRule(siteId, 'cached', {
      mappingMode: 'custom', inputOverrideUsd: 0,
    });
    expect((await resolver.resolveEffectivePrice(input)).inputPerMillionUsd).toBe(0);
  });
});
