import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');
type ServiceModule = typeof import('./factoryResetService.js');

describe('factoryResetService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let performFactoryReset: ServiceModule['performFactoryReset'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-factory-reset-service-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    const serviceModule = await import('./factoryResetService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    performFactoryReset = serviceModule.performFactoryReset;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.proxyVideoTasks).run();
    await db.delete(schema.proxyFiles).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accountGroupRates).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.downstreamApiKeys).run();
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();
    config.authToken = 'reset-token';
    config.proxyToken = 'reset-proxy-token';
    config.systemProxyUrl = 'http://127.0.0.1:7890';
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it.each([
    ['sqlite', 'D:/custom/metapi.db', true],
    ['mysql', 'mysql://user:pass@127.0.0.1:3306/metapi', false],
    ['postgres', 'postgres://user:pass@127.0.0.1:5432/metapi', true],
  ] as const)('preserves the current %s database without switching runtime databases', async (dbType, dbUrl, dbSsl) => {
    config.dbType = dbType;
    config.dbUrl = dbUrl;
    config.dbSsl = dbSsl;
    await db.insert(schema.sites).values({
      name: 'reset-me', url: 'https://reset.example.com', platform: 'new-api',
    }).run();

    const ensureDefaultSitesSeeded = vi.fn(async () => ({
      seeded: 0, alreadyMarked: false, hadExistingSites: false,
    }));
    const switchRuntimeDatabase = vi.fn(async () => undefined);
    await performFactoryReset({
      ensureDefaultSitesSeeded,
      switchRuntimeDatabase,
      runSqliteMigrations: () => undefined,
      stopAccountRateRefreshScheduler: async () => undefined,
      startAccountRateRefreshScheduler: () => undefined,
    });

    expect(config.dbType).toBe(dbType);
    expect(config.dbUrl).toBe(dbUrl);
    expect(config.dbSsl).toBe(dbSsl);
    expect(switchRuntimeDatabase).not.toHaveBeenCalled();
    expect(ensureDefaultSitesSeeded).toHaveBeenCalledTimes(1);
    const settings = Object.fromEntries((await db.select().from(schema.settings).all())
      .map((row) => [row.key, JSON.parse(row.value)]));
    expect(settings).toMatchObject({ db_type: dbType, db_url: dbUrl, db_ssl: dbSsl });
  });

  it('awaits drain, clears backoff only on success, and restarts after consistent reset', async () => {
    config.dbType = 'sqlite';
    config.dbUrl = 'D:/custom/current.db';
    config.dbSsl = false;
    const steps: string[] = [];
    const clearFailure = vi.fn((accountId: number) => { steps.push(`clear:${accountId}`); });
    const account = await db.insert(schema.sites).values({
      name: 'site', url: 'https://site.example.com', platform: 'new-api',
    }).returning().get().then((site) => db.insert(schema.accounts).values({
      siteId: site.id, username: 'user', accessToken: 'session-token', status: 'active',
    }).returning().get());

    await performFactoryReset({
      switchRuntimeDatabase: async () => undefined,
      runSqliteMigrations: () => undefined,
      ensureDefaultSitesSeeded: async () => {
        steps.push('seed');
        return { seeded: 0, alreadyMarked: false, hadExistingSites: false };
      },
      stopAccountRateRefreshScheduler: async () => { steps.push('stop'); },
      startAccountRateRefreshScheduler: () => { steps.push('start'); },
      clearAccountRateRefreshFailureState: clearFailure,
    });

    expect(steps).toEqual(['stop', 'seed', `clear:${account.id}`, 'start']);
  });

  it('clears every pricing-domain table and restores refresh defaults', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'priced-site', url: 'https://priced.example.com', platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id, username: 'priced-user', accessToken: 'token', status: 'active',
    }).returning().get();
    const now = new Date().toISOString();
    await db.insert(schema.sitePricingProfiles).values({ siteId: site.id, paidCny: 2, creditedUsd: 10 }).run();
    await db.insert(schema.officialModelPrices).values({
      providerId: 'openai', modelId: 'gpt-4.1', displayName: 'GPT-4.1', fetchedAt: now,
    }).run();
    await db.insert(schema.siteModelPrices).values({
      siteId: site.id, upstreamModelId: 'gpt-4.1', pricingSemantics: 'base_price', fetchedAt: now,
    }).run();
    await db.insert(schema.siteModelPriceRules).values({
      siteId: site.id, upstreamModelId: 'custom', mappingMode: 'custom',
    }).run();
    await db.insert(schema.accountGroupRateRules).values({
      accountId: account.id, groupKey: 'default', ratioOverride: 0,
    }).run();
    await db.insert(schema.pricingRefreshStates).values({
      scopeType: 'official', scopeId: 0, failureActive: false,
    }).run();

    await performFactoryReset({
      ensureDefaultSitesSeeded: async () => ({ seeded: 0, alreadyMarked: false, hadExistingSites: false }),
      stopAccountRateRefreshScheduler: async () => undefined,
      startAccountRateRefreshScheduler: () => undefined,
      stopPriceRefreshScheduler: async () => undefined,
      startPriceRefreshScheduler: async () => undefined,
    });

    for (const table of [
      schema.sitePricingProfiles,
      schema.officialModelPrices,
      schema.siteModelPrices,
      schema.siteModelPriceRules,
      schema.accountGroupRateRules,
      schema.pricingRefreshStates,
    ]) {
      expect(await db.select().from(table as any).all()).toHaveLength(0);
    }
    const settings = Object.fromEntries((await db.select().from(schema.settings).all())
      .map((row) => [row.key, JSON.parse(row.value)]));
    expect(settings).toMatchObject({
      price_refresh_enabled: true,
      price_refresh_cron: '0 0 * * *',
    });
  });

  it('rolls back persistent reset and restores prior runtime without clearing backoff on failure', async () => {
    config.dbType = 'sqlite';
    config.dbUrl = 'D:/custom/current.db';
    config.dbSsl = false;
    await db.insert(schema.sites).values({
      id: 99, name: 'keep-me', url: 'https://keep.example.com', platform: 'new-api',
    }).run();
    const start = vi.fn(() => undefined);
    const restoreRuntime = vi.fn(async () => undefined);
    const clearFailure = vi.fn(() => undefined);

    await expect(performFactoryReset({
      switchRuntimeDatabase: async () => undefined,
      runSqliteMigrations: () => undefined,
      ensureDefaultSitesSeeded: async () => { throw new Error('seed failed'); },
      stopAccountRateRefreshScheduler: async () => undefined,
      startAccountRateRefreshScheduler: start,
      restorePriorRuntime: restoreRuntime,
      clearAccountRateRefreshFailureState: clearFailure,
    })).rejects.toThrow('seed failed');

    expect((await db.select().from(schema.sites).all()).map((row) => row.id)).toEqual([99]);
    expect(restoreRuntime).toHaveBeenCalledTimes(1);
    expect(clearFailure).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
