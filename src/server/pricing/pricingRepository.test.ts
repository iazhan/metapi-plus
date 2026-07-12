import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type RepositoryModule = typeof import('./pricingRepository.js');

describe('pricing repository', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let repository: RepositoryModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-pricing-repository-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    ({ db, schema } = await import('../db/index.js'));
    repository = await import('./pricingRepository.js');
  });

  beforeEach(async () => {
    await db.delete(schema.officialModelPrices).run();
    await db.delete(schema.siteModelPriceRules).run();
    await db.delete(schema.siteModelPrices).run();
    await db.delete(schema.sitePricingProfiles).run();
    await db.delete(schema.accountGroupRateRules).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  async function createSite(name: string) {
    return db.insert(schema.sites).values({
      name,
      url: `https://${name}.example.com`,
      platform: 'new-api',
    }).returning().get();
  }

  it('atomically replaces the official snapshot', async () => {
    await repository.replaceOfficialPriceSnapshot([{
      providerId: 'openai', modelId: 'old', displayName: 'Old', inputPerMillionUsd: 1,
      fetchedAt: '2026-07-12T00:00:00.000Z',
    }]);
    await repository.replaceOfficialPriceSnapshot([{
      providerId: 'openai', modelId: 'new', displayName: 'New', inputPerMillionUsd: 0,
      fetchedAt: '2026-07-12T01:00:00.000Z',
    }]);

    const rows = await repository.listOfficialModelPrices();
    expect(rows.map((row) => row.modelId)).toEqual(['new']);
    expect(rows[0]?.inputPerMillionUsd).toBe(0);
  });

  it('atomically replaces an official snapshot larger than one SQL parameter batch', async () => {
    const fetchedAt = '2026-07-12T01:00:00.000Z';
    const snapshot = Array.from({ length: 3_000 }, (_, index) => ({
      providerId: 'provider',
      modelId: `model-${index.toString().padStart(4, '0')}`,
      displayName: `Model ${index}`,
      inputPerMillionUsd: index,
      outputPerMillionUsd: index + 1,
      cacheReadPerMillionUsd: null,
      cacheWritePerMillionUsd: null,
      reasoningPerMillionUsd: null,
      inputAudioPerMillionUsd: null,
      outputAudioPerMillionUsd: null,
      tiersJson: null,
      sourceUpdatedAt: null,
      fetchedAt,
    }));

    await repository.replaceOfficialPriceSnapshot(snapshot);

    const rows = await repository.listOfficialModelPrices();
    expect(rows).toHaveLength(snapshot.length);
    expect(rows[0]?.modelId).toBe('model-0000');
    expect(rows.at(-1)?.modelId).toBe('model-2999');
  });

  it('replaces one site without touching another site or manual rules', async () => {
    const first = await createSite('first');
    const second = await createSite('second');
    await repository.replaceSitePriceSnapshot(first.id, [
      { upstreamModelId: 'old', pricingSemantics: 'base_price', inputPerMillionUsd: 1, fetchedAt: '2026-07-12T00:00:00.000Z' },
      { upstreamModelId: 'gone', pricingSemantics: 'base_price', inputPerMillionUsd: 2, fetchedAt: '2026-07-12T00:00:00.000Z' },
    ]);
    await repository.replaceSitePriceSnapshot(second.id, [
      { upstreamModelId: 'other', pricingSemantics: 'base_price', inputPerMillionUsd: 3, fetchedAt: '2026-07-12T00:00:00.000Z' },
    ]);
    await repository.upsertSiteModelPriceRule(first.id, 'old', {
      mappingMode: 'custom', inputOverrideUsd: 0,
    });

    await repository.replaceSitePriceSnapshot(first.id, [
      { upstreamModelId: 'new', pricingSemantics: 'base_price', inputPerMillionUsd: 4, fetchedAt: '2026-07-12T01:00:00.000Z' },
    ]);

    expect((await repository.listSiteModelPrices(first.id)).map((row) => row.upstreamModelId)).toEqual(['new']);
    expect((await repository.listSiteModelPrices(second.id)).map((row) => row.upstreamModelId)).toEqual(['other']);
    expect(await repository.getSiteModelPriceRule(first.id, 'old')).toMatchObject({ inputOverrideUsd: 0 });
  });

  it('uses a default profile until an explicit profile is saved', async () => {
    const site = await createSite('profile');
    expect(await repository.getSitePricingProfile(site.id)).toEqual({ paidCny: 1, creditedUsd: 1 });
    await repository.upsertSitePricingProfile(site.id, { paidCny: 2, creditedUsd: 10 });
    expect(await repository.getSitePricingProfile(site.id)).toEqual({ paidCny: 2, creditedUsd: 10 });
  });

  it('persists and removes site and account manual rules', async () => {
    const site = await createSite('rules');
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user',
      accessToken: 'session',
    }).returning().get();

    await repository.upsertSiteModelPriceRule(site.id, 'free', {
      mappingMode: 'custom', outputOverrideUsd: 0,
    });
    await repository.upsertAccountGroupRateRule(account.id, 'default', 0);
    expect(await repository.getSiteModelPriceRule(site.id, 'free')).toMatchObject({ outputOverrideUsd: 0 });
    expect(await repository.getAccountGroupRateRule(account.id, 'default')).toMatchObject({ ratioOverride: 0 });

    expect(await repository.deleteSiteModelPriceRule(site.id, 'free')).toBe(true);
    expect(await repository.deleteAccountGroupRateRule(account.id, 'default')).toBe(true);
    expect(await repository.getSiteModelPriceRule(site.id, 'free')).toBeNull();
    expect(await repository.getAccountGroupRateRule(account.id, 'default')).toBeNull();
  });

  it('validates a complete snapshot before deleting the previous one', async () => {
    await repository.replaceOfficialPriceSnapshot([{
      providerId: 'openai', modelId: 'stable', displayName: 'Stable', inputPerMillionUsd: 1,
      fetchedAt: '2026-07-12T00:00:00.000Z',
    }]);
    await expect(repository.replaceOfficialPriceSnapshot([{
      providerId: 'openai', modelId: 'invalid', displayName: 'Invalid', inputPerMillionUsd: -1,
      fetchedAt: '2026-07-12T01:00:00.000Z',
    }])).rejects.toThrow();
    expect(await db.select().from(schema.officialModelPrices)
      .where(eq(schema.officialModelPrices.modelId, 'stable')).get()).toBeDefined();
  });
});
