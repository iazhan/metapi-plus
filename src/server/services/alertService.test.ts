import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDataDir, type TestDataDir } from '../test-fixtures/testDataDir.js';

const sendNotificationMock = vi.fn();

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type AlertModule = typeof import('./alertService.js');
type AccountHealthModule = typeof import('./accountHealthService.js');

describe('alertService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let reportTokenExpired: AlertModule['reportTokenExpired'];
  let extractRuntimeHealth: AccountHealthModule['extractRuntimeHealth'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-alert-service-');
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const alertModule = await import('./alertService.js');
    const accountHealthModule = await import('./accountHealthService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    reportTokenExpired = alertModule.reportTokenExpired;
    extractRuntimeHealth = accountHealthModule.extractRuntimeHealth;
  });

  beforeEach(async () => {
    sendNotificationMock.mockReset();
    await db.run(sql`DROP TRIGGER IF EXISTS rotate_session_after_token_event`);
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await testDataDir.cleanup(closeDbConnections);
  });

  it('does not expire a newer session when an old request reports a 401', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Session Race Site',
      url: 'https://session-race.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();
    const currentExtraConfig = JSON.stringify({
      credentialMode: 'session',
      sub2apiAuth: {
        refreshToken: 'rotated-refresh-token',
        tokenExpiresAt: Date.parse('2026-07-22T00:00:00.000Z'),
      },
    });
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'session-race@example.com',
      accessToken: 'new-access-token',
      status: 'active',
      extraConfig: currentExtraConfig,
    }).returning().get();

    const result = await reportTokenExpired({
      accountId: account.id,
      username: account.username,
      siteName: site.name,
      detail: 'HTTP 401',
      expectedAccessToken: 'old-access-token',
      expectedExtraConfig: JSON.stringify({
        credentialMode: 'session',
        sub2apiAuth: {
          refreshToken: 'old-refresh-token',
          tokenExpiresAt: Date.parse('2026-07-21T00:00:00.000Z'),
        },
      }),
    });

    expect(result).toEqual({ reported: false });
    await expect(db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get())
      .resolves.toMatchObject({
        status: 'active',
        accessToken: 'new-access-token',
        extraConfig: currentExtraConfig,
      });
    await expect(db.select().from(schema.events).all()).resolves.toEqual([]);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('expires and reports the session that produced the 401', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Current Session Site',
      url: 'https://current-session.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();
    const extraConfig = JSON.stringify({
      credentialMode: 'session',
      sub2apiAuth: {
        refreshToken: 'current-refresh-token',
        tokenExpiresAt: Date.parse('2026-07-22T00:00:00.000Z'),
      },
    });
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'current-session@example.com',
      accessToken: 'current-access-token',
      status: 'active',
      extraConfig,
    }).returning().get();

    const result = await reportTokenExpired({
      accountId: account.id,
      username: account.username,
      siteName: site.name,
      detail: 'HTTP 401',
      expectedAccessToken: account.accessToken,
      expectedExtraConfig: account.extraConfig,
    });

    expect(result).toEqual({ reported: true });
    const storedAccount = await db.select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(storedAccount).toMatchObject({ status: 'expired' });
    expect(extractRuntimeHealth(storedAccount?.extraConfig)).toMatchObject({
      state: 'unhealthy',
      reason: expect.stringContaining('HTTP 401'),
      source: 'auth',
    });
    await expect(db.select().from(schema.events).all()).resolves.toEqual([
      expect.objectContaining({
        type: 'token',
        title: 'Token 已失效',
        relatedId: account.id,
        relatedType: 'account',
      }),
    ]);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('does not write stale failure health after the session rotates during reporting', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Reporting Race Site',
      url: 'https://reporting-race.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();
    const originalExtraConfig = JSON.stringify({
      credentialMode: 'session',
      sub2apiAuth: { refreshToken: 'original-refresh-token' },
    });
    const rotatedExtraConfig = JSON.stringify({
      credentialMode: 'session',
      sub2apiAuth: { refreshToken: 'rotated-refresh-token' },
    });
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'reporting-race@example.com',
      accessToken: 'original-access-token',
      status: 'active',
      extraConfig: originalExtraConfig,
    }).returning().get();

    await db.run(sql.raw(`
      CREATE TRIGGER rotate_session_after_token_event
      AFTER INSERT ON events
      WHEN NEW.type = 'token' AND NEW.related_id = ${account.id}
      BEGIN
        UPDATE accounts
        SET access_token = 'rotated-access-token',
            extra_config = '${rotatedExtraConfig}',
            status = 'active'
        WHERE id = ${account.id};
      END
    `));

    const result = await reportTokenExpired({
      accountId: account.id,
      username: account.username,
      siteName: site.name,
      detail: 'HTTP 401',
      expectedAccessToken: account.accessToken,
      expectedExtraConfig: account.extraConfig,
    });

    expect(result).toEqual({ reported: true });
    await expect(db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get())
      .resolves.toMatchObject({
        accessToken: 'rotated-access-token',
        extraConfig: rotatedExtraConfig,
        status: 'active',
      });
  });
});
