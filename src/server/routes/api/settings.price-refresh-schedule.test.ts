import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDataDir, type TestDataDir } from '../../test-fixtures/testDataDir.js';

const { updatePriceRefreshSchedulerMock } = vi.hoisted(() => ({
  updatePriceRefreshSchedulerMock: vi.fn(),
}));

vi.mock('../../pricing/priceRefreshScheduler.js', () => ({
  updatePriceRefreshScheduler: updatePriceRefreshSchedulerMock,
}));

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');

describe('settings price refresh schedule', () => {
  let app: FastifyInstance;
  let config: ConfigModule['config'];
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-settings-price-refresh-');
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
    config.priceRefreshEnabled = true;
    config.priceRefreshCron = '0 0 * * *';
    config.priceRefreshScheduleMode = 'cron';
    config.priceRefreshIntervalHours = 6;
    updatePriceRefreshSchedulerMock.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app.close();
    await testDataDir.cleanup(closeDbConnections);
  });

  it('returns price refresh scheduling fields from runtime settings', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings/runtime' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      priceRefreshEnabled: true,
      priceRefreshCron: '0 0 * * *',
      priceRefreshScheduleMode: 'cron',
      priceRefreshIntervalHours: 6,
    });
  });

  it('persists and applies interval scheduling', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        priceRefreshEnabled: false,
        priceRefreshCron: '0 3 * * *',
        priceRefreshScheduleMode: 'interval',
        priceRefreshIntervalHours: 4,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updatePriceRefreshSchedulerMock).toHaveBeenCalledWith({
      enabled: false,
      cronExpr: '0 3 * * *',
      scheduleMode: 'interval',
      intervalHours: 4,
    });
    const savedMode = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'price_refresh_schedule_mode')).get();
    const savedInterval = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'price_refresh_interval_hours')).get();
    expect(savedMode?.value).toBe(JSON.stringify('interval'));
    expect(savedInterval?.value).toBe(JSON.stringify(4));
  });

  it.each([0, 25, 3.5])('rejects invalid interval %s', async (intervalHours) => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { priceRefreshIntervalHours: intervalHours },
    });

    expect(response.statusCode).toBe(400);
    expect(updatePriceRefreshSchedulerMock).not.toHaveBeenCalled();
  });
});
