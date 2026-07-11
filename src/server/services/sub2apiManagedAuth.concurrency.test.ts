import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDataDir, type TestDataDir } from '../test-fixtures/testDataDir.js';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('undici', () => ({ fetch: fetchMock }));

type DbModule = typeof import('../db/index.js');
type ManagedAuthModule = typeof import('./sub2apiManagedAuth.js');
type RefreshSingleflightModule = typeof import('./sub2apiRefreshSingleflight.js');

describe('sub2apiManagedAuth concurrency', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let refreshSub2ApiManagedSession: ManagedAuthModule['refreshSub2ApiManagedSession'];
  let refreshSub2ApiManagedSessionSingleflight: RefreshSingleflightModule['refreshSub2ApiManagedSessionSingleflight'];
  let resetSingleflight: RefreshSingleflightModule['__resetSub2ApiManagedRefreshSingleflightForTests'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-sub2api-session-concurrency-');
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const managedAuth = await import('./sub2apiManagedAuth.js');
    const refreshSingleflight = await import('./sub2apiRefreshSingleflight.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    refreshSub2ApiManagedSession = managedAuth.refreshSub2ApiManagedSession;
    refreshSub2ApiManagedSessionSingleflight = refreshSingleflight.refreshSub2ApiManagedSessionSingleflight;
    resetSingleflight = refreshSingleflight.__resetSub2ApiManagedRefreshSingleflightForTests;
  });

  beforeEach(async () => {
    fetchMock.mockReset();
    resetSingleflight();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await testDataDir.cleanup(closeDbConnections);
  });

  it('does not reactivate an account disabled while a managed refresh is in flight', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Sub2API Site',
      url: 'https://sub2.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();
    const originalConfig = JSON.stringify({
      credentialMode: 'session',
      sub2apiAuth: { refreshToken: 'old-refresh-token', tokenExpiresAt: 1 },
    });
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'sub2-user@example.com',
      accessToken: 'old-access-token',
      status: 'active',
      extraConfig: originalConfig,
      updatedAt: '2026-07-11T00:00:00.000Z',
    }).returning().get();

    let resolveFetch!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const refresh = refreshSub2ApiManagedSession({
      account,
      site,
      currentAccessToken: account.accessToken,
      currentExtraConfig: account.extraConfig,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const disabledConfig = JSON.stringify({ credentialMode: 'session', disabledByAdmin: true });
    await db.update(schema.accounts).set({
      status: 'disabled',
      accessToken: 'admin-access-token',
      extraConfig: disabledConfig,
      updatedAt: '2026-07-11T00:01:00.000Z',
    }).where(eq(schema.accounts.id, account.id)).run();
    resolveFetch({
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: {
          access_token: 'stale-refreshed-access-token',
          refresh_token: 'stale-refreshed-refresh-token',
          expires_in: 3600,
        },
      }),
    });

    await expect(refresh).rejects.toThrow('account session changed during refresh');
    await expect(db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get())
      .resolves.toMatchObject({
        status: 'disabled',
        accessToken: 'admin-access-token',
        extraConfig: disabledConfig,
      });
  });

  it('does not persist an abandoned managed-refresh generation', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Sub2API Generation Site',
      url: 'https://sub2-generation.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();
    const originalConfig = JSON.stringify({
      credentialMode: 'session',
      sub2apiAuth: { refreshToken: 'old-refresh-token', tokenExpiresAt: 1 },
    });
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'sub2-generation@example.com',
      accessToken: 'old-access-token',
      status: 'expired',
      extraConfig: originalConfig,
      updatedAt: '2026-07-11T00:00:00.000Z',
    }).returning().get();
    const abandonedOwner = new AbortController();
    let abandonedTokenRead = false;
    fetchMock
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: {
            get access_token() {
              abandonedTokenRead = true;
              abandonedOwner.abort(new DOMException('abandon stale refresh', 'AbortError'));
              return 'abandoned-access-token';
            },
            refresh_token: 'abandoned-refresh-token',
            expires_in: 3600,
          },
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: {
            access_token: 'winner-access-token',
            refresh_token: 'winner-refresh-token',
            expires_in: 3600,
          },
        }),
      });

    const params = {
      account,
      site,
      currentAccessToken: account.accessToken,
      currentExtraConfig: account.extraConfig,
    };
    const abandoned = refreshSub2ApiManagedSessionSingleflight({
      ...params,
      signal: abandonedOwner.signal,
    });
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(abandonedTokenRead).toBe(true));

    const afterAbandoned = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(afterAbandoned).toMatchObject({
      status: 'expired',
      accessToken: 'old-access-token',
      extraConfig: originalConfig,
    });

    await expect(refreshSub2ApiManagedSessionSingleflight(params)).resolves.toMatchObject({
      accessToken: 'winner-access-token',
    });
    const afterWinner = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(afterWinner).toMatchObject({
      status: 'active',
      accessToken: 'winner-access-token',
    });
    expect(JSON.parse(String(afterWinner?.extraConfig))).toMatchObject({
      sub2apiAuth: { refreshToken: 'winner-refresh-token' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
