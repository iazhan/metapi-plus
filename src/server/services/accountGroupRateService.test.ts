import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataDir, type TestDataDir } from '../test-fixtures/testDataDir.js';

type DbModule = typeof import('../db/index.js');

describe('accountGroupRateService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-account-group-rates-');
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
  });

  beforeEach(async () => {
    await db.delete(schema.accountGroupRates).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await testDataDir.cleanup(closeDbConnections);
  });

  async function createAccount() {
    const site = await db.insert(schema.sites).values({
      name: 'Rate Site',
      url: 'https://rates.example.com',
      platform: 'new-api',
    }).returning().get();
    return db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rate-user',
      accessToken: 'session-token',
    }).returning().get();
  }

  it('replaces one account snapshot atomically and removes stale groups', async () => {
    const account = await createAccount();
    const service = await import('./accountGroupRateService.js');
    await service.replaceAccountGroupRates(account.id, [
      { groupKey: 'default', groupName: 'Default', description: 'Old', ratio: 1 },
      { groupKey: 'vip', groupName: 'VIP', description: 'Premium', ratio: 0.8 },
    ], '2026-07-10T01:00:00.000Z');

    await service.replaceAccountGroupRates(account.id, [
      { groupKey: 'vip', groupName: 'VIP', description: 'Updated', ratio: 0.75 },
      { groupKey: ' vip ', groupName: 'Ignored duplicate', ratio: 0.7 },
      { groupKey: 'pro', groupName: 'Pro', ratio: 1.25 },
    ], '2026-07-10T02:00:00.000Z');

    await expect(service.listAccountGroupRates(account.id)).resolves.toEqual([
      expect.objectContaining({
        accountId: account.id,
        groupKey: 'pro',
        groupName: 'Pro',
        ratio: 1.25,
        lastSyncedAt: '2026-07-10T02:00:00.000Z',
      }),
      expect.objectContaining({
        accountId: account.id,
        groupKey: 'vip',
        groupName: 'Ignored duplicate',
        ratio: 0.7,
        lastSyncedAt: '2026-07-10T02:00:00.000Z',
      }),
    ]);
  });

  it.each([
    { groupKey: '', groupName: 'Invalid', ratio: 2 },
    { groupKey: 'broken', groupName: 'Broken', ratio: Number.NaN },
    { groupKey: 'negative', groupName: 'Negative', ratio: -1 },
  ])('rejects a non-empty malformed snapshot and preserves the previous rows', async (invalidRate) => {
    const account = await createAccount();
    const service = await import('./accountGroupRateService.js');
    await service.replaceAccountGroupRates(account.id, [
      { groupKey: 'legacy', groupName: 'Legacy', ratio: 1.5 },
    ], '2026-07-09T00:00:00.000Z');

    await expect(service.replaceAccountGroupRates(account.id, [
      { groupKey: 'valid', groupName: 'Valid', ratio: 1 },
      invalidRate,
    ])).rejects.toThrow(/invalid group rate/i);

    await expect(service.listAccountGroupRates(account.id)).resolves.toEqual([
      expect.objectContaining({
        groupKey: 'legacy',
        ratio: 1.5,
        lastSyncedAt: '2026-07-09T00:00:00.000Z',
      }),
    ]);
  });

  it('clears stale rows after a successful empty snapshot', async () => {
    const account = await createAccount();
    const service = await import('./accountGroupRateService.js');
    await service.replaceAccountGroupRates(account.id, [
      { groupKey: 'default', groupName: 'Default', ratio: 1 },
    ]);

    const result = await service.replaceAccountGroupRates(account.id, []);

    expect(result).toEqual({ total: 0 });
    await expect(service.listAccountGroupRates(account.id)).resolves.toEqual([]);
  });

});
