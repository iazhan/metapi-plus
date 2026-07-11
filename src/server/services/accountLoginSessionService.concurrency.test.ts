import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDataDir, type TestDataDir } from '../test-fixtures/testDataDir.js';

const adapterMock = vi.hoisted(() => ({ login: vi.fn() }));

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => adapterMock,
}));

vi.mock('./accountCredentialService.js', () => ({
  decryptAccountPassword: () => 'plain-password',
}));

vi.mock('./siteProxy.js', () => ({
  withAccountProxyOverride: (_proxyUrl: string | null, operation: () => unknown) => operation(),
}));

type DbModule = typeof import('../db/index.js');
type SessionModule = typeof import('./accountLoginSessionService.js');

describe('accountLoginSessionService concurrency', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let reloginAccountSession: SessionModule['reloginAccountSession'];
  let resetSingleflight: SessionModule['__resetAccountReloginSingleflightForTests'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-account-session-concurrency-');
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const sessionModule = await import('./accountLoginSessionService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    reloginAccountSession = sessionModule.reloginAccountSession;
    resetSingleflight = sessionModule.__resetAccountReloginSingleflightForTests;
  });

  beforeEach(async () => {
    adapterMock.login.mockReset();
    resetSingleflight();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await testDataDir.cleanup(closeDbConnections);
  });

  async function seedAccount() {
    const site = await db.insert(schema.sites).values({
      name: 'Session Site',
      url: 'https://session.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'session-user@example.com',
      accessToken: 'stale-access-token',
      status: 'expired',
      balance: 1,
      extraConfig: JSON.stringify({
        keep: 'original',
        credentialMode: 'session',
        autoRelogin: {
          username: 'session-user@example.com',
          passwordCipher: 'encrypted-password',
        },
      }),
      updatedAt: '2026-07-11T00:00:00.000Z',
    }).returning().get();
    return { account, site };
  }

  function deferSuccessfulLogin() {
    let resolveLogin!: (value: unknown) => void;
    adapterMock.login.mockReturnValue(new Promise((resolve) => {
      resolveLogin = resolve;
    }));
    return (accessToken: string, platformUserId = 7788) => resolveLogin({
      success: true,
      accessToken,
      platformUserId,
    });
  }

  it('does not overwrite an account disabled while password relogin is in flight', async () => {
    const { account, site } = await seedAccount();
    const resolveLogin = deferSuccessfulLogin();
    const relogin = reloginAccountSession(account, site);
    await vi.waitFor(() => expect(adapterMock.login).toHaveBeenCalledTimes(1));

    const disabledConfig = JSON.stringify({ credentialMode: 'session', disabledByAdmin: true });
    await db.update(schema.accounts).set({
      status: 'disabled',
      accessToken: 'admin-session-token',
      extraConfig: disabledConfig,
      updatedAt: '2026-07-11T00:01:00.000Z',
    }).where(eq(schema.accounts.id, account.id)).run();
    resolveLogin('stale-background-token');

    await expect(relogin).resolves.toBeNull();
    await expect(db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get())
      .resolves.toMatchObject({
        status: 'disabled',
        accessToken: 'admin-session-token',
        extraConfig: disabledConfig,
      });
  });

  it('does not overwrite a newer manual session while password relogin is in flight', async () => {
    const { account, site } = await seedAccount();
    const resolveLogin = deferSuccessfulLogin();
    const relogin = reloginAccountSession(account, site);
    await vi.waitFor(() => expect(adapterMock.login).toHaveBeenCalledTimes(1));

    const manualConfig = JSON.stringify({ credentialMode: 'session', manualLoginGeneration: 2 });
    await db.update(schema.accounts).set({
      status: 'active',
      accessToken: 'manual-session-token',
      extraConfig: manualConfig,
      updatedAt: '2026-07-11T00:02:00.000Z',
    }).where(eq(schema.accounts.id, account.id)).run();
    resolveLogin('stale-background-token');

    await expect(relogin).resolves.toBeNull();
    await expect(db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get())
      .resolves.toMatchObject({
        status: 'active',
        accessToken: 'manual-session-token',
        extraConfig: manualConfig,
      });
  });

  it('preserves unrelated account updates while committing a current relogin result', async () => {
    const { account, site } = await seedAccount();
    const resolveLogin = deferSuccessfulLogin();
    const relogin = reloginAccountSession(account, site);
    await vi.waitFor(() => expect(adapterMock.login).toHaveBeenCalledTimes(1));

    await db.update(schema.accounts).set({
      balance: 42,
      updatedAt: '2026-07-11T00:03:00.000Z',
    }).where(eq(schema.accounts.id, account.id)).run();
    resolveLogin('fresh-background-token', 9911);

    await expect(relogin).resolves.toMatchObject({
      accessToken: 'fresh-background-token',
      platformUserId: 9911,
    });
    const latest = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(latest).toMatchObject({
      status: 'active',
      accessToken: 'fresh-background-token',
      balance: 42,
    });
    expect(JSON.parse(String(latest?.extraConfig))).toMatchObject({ keep: 'original', platformUserId: 9911 });
  });

  it('does not persist an abandoned password relogin generation', async () => {
    const { account, site } = await seedAccount();
    const abandonedOwner = new AbortController();
    let abandonedTokenRead = false;
    let tokenReadCount = 0;
    adapterMock.login
      .mockResolvedValueOnce({
        success: true,
        get accessToken() {
          tokenReadCount += 1;
          if (tokenReadCount === 2) {
            abandonedTokenRead = true;
            abandonedOwner.abort(new DOMException('abandon stale relogin', 'AbortError'));
          }
          return 'abandoned-access-token';
        },
        platformUserId: 1101,
      })
      .mockResolvedValueOnce({
        success: true,
        accessToken: 'winner-access-token',
        platformUserId: 2202,
      });

    const abandoned = reloginAccountSession(account, site, { signal: abandonedOwner.signal });
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(abandonedTokenRead).toBe(true));

    const afterAbandoned = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(afterAbandoned).toMatchObject({
      status: 'expired',
      accessToken: 'stale-access-token',
      extraConfig: account.extraConfig,
    });

    await expect(reloginAccountSession(account, site)).resolves.toMatchObject({
      accessToken: 'winner-access-token',
      platformUserId: 2202,
    });
    const afterWinner = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(afterWinner).toMatchObject({
      status: 'active',
      accessToken: 'winner-access-token',
    });
    expect(JSON.parse(String(afterWinner?.extraConfig))).toMatchObject({ platformUserId: 2202 });
    expect(adapterMock.login).toHaveBeenCalledTimes(2);
  });
});
