import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDataDir, type TestDataDir } from '../test-fixtures/testDataDir.js';

type DbModule = typeof import('../db/index.js');
type PersistenceModule = typeof import('./accountSessionPersistenceService.js');

describe('accountSessionPersistenceService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let persistRecoveredAccountSession: PersistenceModule['persistRecoveredAccountSession'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-account-session-persistence-');
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const persistenceModule = await import('./accountSessionPersistenceService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    persistRecoveredAccountSession = persistenceModule.persistRecoveredAccountSession;
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await testDataDir.cleanup(closeDbConnections);
  });

  it('rolls back an updated session when its generation aborts before transaction commit', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Persistence Site',
      url: 'https://persistence.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const originalConfig = JSON.stringify({ keep: 'original' });
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'persistence@example.com',
      accessToken: 'old-access-token',
      status: 'expired',
      extraConfig: originalConfig,
      updatedAt: '2026-07-11T00:00:00.000Z',
    }).returning().get();
    const controller = new AbortController();

    const persistence = persistRecoveredAccountSession({
      account,
      accessToken: 'abandoned-access-token',
      signal: controller.signal,
      mergeExtraConfig: () => {
        queueMicrotask(() => controller.abort(
          new DOMException('abandon before commit', 'AbortError'),
        ));
        return JSON.stringify({ keep: 'abandoned' });
      },
    });

    await expect(persistence).rejects.toMatchObject({ name: 'AbortError' });
    await expect(db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get())
      .resolves.toMatchObject({
        status: 'expired',
        accessToken: 'old-access-token',
        extraConfig: originalConfig,
        updatedAt: '2026-07-11T00:00:00.000Z',
      });
  });
});
