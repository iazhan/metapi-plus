import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDataDir, type TestDataDir } from '../../test-fixtures/testDataDir.js';

const { startModelAvailabilityProbeSchedulerMock, stopModelAvailabilityProbeSchedulerMock } = vi.hoisted(() => ({
  startModelAvailabilityProbeSchedulerMock: vi.fn(),
  stopModelAvailabilityProbeSchedulerMock: vi.fn(),
}));

vi.mock('../../services/modelAvailabilityProbeService.js', () => ({
  startModelAvailabilityProbeScheduler: startModelAvailabilityProbeSchedulerMock,
  stopModelAvailabilityProbeScheduler: stopModelAvailabilityProbeSchedulerMock,
}));

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');

describe('settings model availability probe runtime setting', () => {
  let app: FastifyInstance;
  let config: ConfigModule['config'];
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-settings-model-probe-');

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
    config.modelAvailabilityProbeEnabled = false;
    startModelAvailabilityProbeSchedulerMock.mockReset();
    stopModelAvailabilityProbeSchedulerMock.mockReset();
  });

  afterAll(async () => {
    await app.close();
    await testDataDir.cleanup(closeDbConnections);
  });

  it('persists enabling the model availability probe and starts the scheduler', async () => {
    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        modelAvailabilityProbeEnabled: true,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json() as { modelAvailabilityProbeEnabled?: boolean };
    expect(updated.modelAvailabilityProbeEnabled).toBe(true);
    expect(config.modelAvailabilityProbeEnabled).toBe(true);
    expect(startModelAvailabilityProbeSchedulerMock).toHaveBeenCalledTimes(1);
    expect(stopModelAvailabilityProbeSchedulerMock).not.toHaveBeenCalled();

    const saved = await db.select().from(schema.settings).where(eq(schema.settings.key, 'model_availability_probe_enabled')).get();
    expect(saved?.value).toBe(JSON.stringify(true));

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/settings/runtime',
    });
    expect(getResponse.statusCode).toBe(200);
    expect((getResponse.json() as { modelAvailabilityProbeEnabled?: boolean }).modelAvailabilityProbeEnabled).toBe(true);
  });

  it('persists disabling the model availability probe and stops the scheduler', async () => {
    config.modelAvailabilityProbeEnabled = true;

    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        modelAvailabilityProbeEnabled: false,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json() as { modelAvailabilityProbeEnabled?: boolean };
    expect(updated.modelAvailabilityProbeEnabled).toBe(false);
    expect(config.modelAvailabilityProbeEnabled).toBe(false);
    expect(stopModelAvailabilityProbeSchedulerMock).toHaveBeenCalledTimes(1);
    expect(startModelAvailabilityProbeSchedulerMock).not.toHaveBeenCalled();

    const saved = await db.select().from(schema.settings).where(eq(schema.settings.key, 'model_availability_probe_enabled')).get();
    expect(saved?.value).toBe(JSON.stringify(false));
  });
});
