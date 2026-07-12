import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDataDir, type TestDataDir } from '../../test-fixtures/testDataDir.js';

const { updateAccountRateRefreshSchedulerMock } = vi.hoisted(() => ({
  updateAccountRateRefreshSchedulerMock: vi.fn(),
}));

vi.mock('../../services/accountRateRefreshScheduler.js', () => ({
  updateAccountRateRefreshScheduler: updateAccountRateRefreshSchedulerMock,
}));

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');

describe('settings account group rate refresh runtime settings', () => {
  let app: FastifyInstance;
  let config: ConfigModule['config'];
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-settings-account-rate-refresh-');

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const settingsRoutesModule = await import('./settings.js');

    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    config = configModule.config;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    config.accountGroupRateRefreshEnabled = true;
    config.accountGroupRateRefreshIntervalMinutes = 30;
    updateAccountRateRefreshSchedulerMock.mockReset();
  });

  afterAll(async () => {
    await app.close();
    await testDataDir.cleanup(closeDbConnections);
  });

  it('returns account group rate refresh settings from the runtime endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings/runtime' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accountGroupRateRefreshEnabled: true,
      accountGroupRateRefreshIntervalMinutes: 30,
    });
  });

  it('persists a valid setting pair before updating the live scheduler', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        accountGroupRateRefreshEnabled: true,
        accountGroupRateRefreshIntervalMinutes: 45,
      },
    });

    expect(response.statusCode).toBe(200);
    const savedEnabled = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'account_group_rate_refresh_enabled')).get();
    const savedInterval = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'account_group_rate_refresh_interval_minutes')).get();
    expect(config.accountGroupRateRefreshEnabled).toBe(true);
    expect(config.accountGroupRateRefreshIntervalMinutes).toBe(45);
    expect(updateAccountRateRefreshSchedulerMock).toHaveBeenCalledWith({
      enabled: true,
      intervalMinutes: 45,
    });
    expect(savedEnabled?.value).toBe(JSON.stringify(true));
    expect(savedInterval?.value).toBe(JSON.stringify(45));
  });

  it('preserves the configured interval when only disabling the scheduler', async () => {
    config.accountGroupRateRefreshIntervalMinutes = 45;

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { accountGroupRateRefreshEnabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(config.accountGroupRateRefreshEnabled).toBe(false);
    expect(config.accountGroupRateRefreshIntervalMinutes).toBe(45);
    expect(updateAccountRateRefreshSchedulerMock).toHaveBeenCalledWith({
      enabled: false,
      intervalMinutes: 45,
    });
    const savedInterval = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'account_group_rate_refresh_interval_minutes')).get();
    expect(savedInterval?.value).toBe(JSON.stringify(45));
  });

  it('does not apply the rate refresh pair when a later runtime setting validation fails', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        accountGroupRateRefreshEnabled: false,
        accountGroupRateRefreshIntervalMinutes: 45,
        routingFallbackUnitCost: 0,
      },
    });

    expect(response.statusCode).toBe(400);
    const savedEnabled = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'account_group_rate_refresh_enabled')).get();
    const savedInterval = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'account_group_rate_refresh_interval_minutes')).get();
    expect(savedEnabled).toBeUndefined();
    expect(savedInterval).toBeUndefined();
    expect(config.accountGroupRateRefreshEnabled).toBe(true);
    expect(config.accountGroupRateRefreshIntervalMinutes).toBe(30);
    expect(updateAccountRateRefreshSchedulerMock).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean enabled value without changing runtime state', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { accountGroupRateRefreshEnabled: 'true' },
    });

    expect(response.statusCode).toBe(400);
    expect(config.accountGroupRateRefreshEnabled).toBe(true);
    expect(config.accountGroupRateRefreshIntervalMinutes).toBe(30);
    expect(await db.select().from(schema.settings).all()).toEqual([]);
    expect(updateAccountRateRefreshSchedulerMock).not.toHaveBeenCalled();
  });

  it.each([4, 30.5, 10_081])('rejects invalid interval %s without changing runtime state', async (intervalMinutes) => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { accountGroupRateRefreshIntervalMinutes: intervalMinutes },
    });

    expect(response.statusCode).toBe(400);
    expect(config.accountGroupRateRefreshEnabled).toBe(true);
    expect(config.accountGroupRateRefreshIntervalMinutes).toBe(30);
    expect(await db.select().from(schema.settings).all()).toEqual([]);
    expect(updateAccountRateRefreshSchedulerMock).not.toHaveBeenCalled();
  });
});
