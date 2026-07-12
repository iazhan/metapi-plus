import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDataDir, type TestDataDir } from '../test-fixtures/testDataDir.js';

const getAdapterMock = vi.fn();
const refreshAccountGroupRatesMock = vi.hoisted(() => vi.fn());
const recoverAccountSessionMock = vi.hoisted(() => vi.fn());

vi.mock('./platforms/index.js', () => ({
  getAdapter: (...args: unknown[]) => getAdapterMock(...args),
}));

vi.mock('./accountLoginSessionService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./accountLoginSessionService.js')>();
  return {
    ...actual,
    recoverAccountSession: (...args: unknown[]) => recoverAccountSessionMock(...args),
  };
});

vi.mock('./accountRateSyncService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./accountRateSyncService.js')>();
  refreshAccountGroupRatesMock.mockImplementation(
    (...args: Parameters<typeof actual.refreshAccountGroupRates>) => actual.refreshAccountGroupRates(...args),
  );
  return {
    ...actual,
    refreshAccountGroupRates: (...args: Parameters<typeof actual.refreshAccountGroupRates>) => (
      refreshAccountGroupRatesMock(...args)
    ),
  };
});

type DbModule = typeof import('../db/index.js');

describe('accountPlatformSyncService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-account-platform-sync-');
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
  });

  beforeEach(async () => {
    getAdapterMock.mockReset();
    refreshAccountGroupRatesMock.mockClear();
    recoverAccountSessionMock.mockReset();
    await db.delete(schema.accountGroupRates).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await testDataDir.cleanup(closeDbConnections);
  });

  async function createAccountRow() {
    const site = await db.insert(schema.sites).values({
      name: 'Sync Site',
      url: 'https://sync.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'sync-user',
      accessToken: 'session-token',
    }).returning().get();
    return { accounts: account, sites: site };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  }

  it('synchronizes tokens and group rates in one platform flow', async () => {
    const row = await createAccountRow();
    const getApiTokens = vi.fn().mockResolvedValue([
      { name: 'VIP token', key: 'sk-vip-token', enabled: true, tokenGroup: 'vip' },
    ]);
    const getApiToken = vi.fn().mockResolvedValue(null);
    const getGroupRates = vi.fn().mockResolvedValue([
      { groupKey: 'vip', groupName: 'VIP', ratio: 0.8 },
    ]);
    getAdapterMock.mockReturnValue({ getApiTokens, getApiToken, getGroupRates });

    const service = await import('./accountPlatformSyncService.js');
    const result = await service.syncAccountPlatformData(row);

    expect(result).toMatchObject({
      status: 'synced',
      synced: true,
      created: 1,
      rateSync: { status: 'synced', total: 1 },
    });
    await expect(db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, row.accounts.id)).all())
      .resolves.toEqual([expect.objectContaining({ token: 'sk-vip-token', tokenGroup: 'vip' })]);
    await expect(db.select().from(schema.accountGroupRates)
      .where(eq(schema.accountGroupRates.accountId, row.accounts.id)).all())
      .resolves.toEqual([expect.objectContaining({ groupKey: 'vip', ratio: 0.8 })]);
  });

  it('delegates rate synchronization and preserves its serialized result shape', async () => {
    const row = await createAccountRow();
    getAdapterMock.mockReturnValue({
      getApiTokens: vi.fn().mockResolvedValue([
        { name: 'default', key: 'sk-default-token', enabled: true },
      ]),
      getApiToken: vi.fn().mockResolvedValue(null),
      getGroupRates: vi.fn().mockResolvedValue([
        { groupKey: 'local', groupName: 'Local', ratio: 1 },
      ]),
    });
    refreshAccountGroupRatesMock.mockResolvedValueOnce({
      rateSync: { status: 'failed', message: 'delegated rate failure' },
      recoveredSession: false,
      failureKind: 'upstream',
    });

    const service = await import('./accountPlatformSyncService.js');
    const result = await service.syncAccountPlatformData(row);

    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledWith(
      row,
      { signal: expect.any(AbortSignal) },
    );
    expect(result.rateSync).toEqual({ status: 'failed', message: 'delegated rate failure' });
  });

  it('marks group rates unsupported when the adapter has no rate capability', async () => {
    const row = await createAccountRow();
    getAdapterMock.mockReturnValue({
      getApiTokens: vi.fn().mockResolvedValue([
        { name: 'default', key: 'sk-default-token', enabled: true },
      ]),
      getApiToken: vi.fn().mockResolvedValue(null),
    });

    const service = await import('./accountPlatformSyncService.js');
    await expect(service.syncAccountPlatformData(row)).resolves.toMatchObject({
      status: 'synced',
      synced: true,
      rateSync: { status: 'unsupported' },
    });
  });

  it('keeps successful token changes and the previous rate snapshot when rate sync fails', async () => {
    const row = await createAccountRow();
    const rateService = await import('./accountGroupRateService.js');
    await rateService.replaceAccountGroupRates(row.accounts.id, [
      { groupKey: 'legacy', groupName: 'Legacy', ratio: 1.5 },
    ], '2026-07-09T00:00:00.000Z');
    getAdapterMock.mockReturnValue({
      getApiTokens: vi.fn().mockResolvedValue([
        { name: 'new token', key: 'sk-new-token', enabled: true },
      ]),
      getApiToken: vi.fn().mockResolvedValue(null),
      getGroupRates: vi.fn().mockRejectedValue(new Error('rate endpoint unavailable')),
    });

    const service = await import('./accountPlatformSyncService.js');
    const result = await service.syncAccountPlatformData(row);

    expect(result).toMatchObject({
      status: 'synced',
      synced: true,
      created: 1,
      rateSync: { status: 'failed', message: 'rate endpoint unavailable' },
    });
    await expect(db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, row.accounts.id)).all())
      .resolves.toEqual([expect.objectContaining({ token: 'sk-new-token' })]);
    await expect(rateService.listAccountGroupRates(row.accounts.id)).resolves.toEqual([
      expect.objectContaining({
        groupKey: 'legacy',
        ratio: 1.5,
        lastSyncedAt: '2026-07-09T00:00:00.000Z',
      }),
    ]);
  });

  it('synchronizes group rates even when the upstream returns no api tokens', async () => {
    const row = await createAccountRow();
    getAdapterMock.mockReturnValue({
      getApiTokens: vi.fn().mockResolvedValue([]),
      getApiToken: vi.fn().mockResolvedValue(null),
      getGroupRates: vi.fn().mockResolvedValue([
        { groupKey: 'vip', groupName: 'VIP', ratio: 0.8 },
      ]),
    });

    const service = await import('./accountPlatformSyncService.js');
    const result = await service.syncAccountPlatformData(row);

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'no_upstream_tokens',
      synced: false,
      rateSync: { status: 'synced', total: 1 },
    });
    await expect(db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, row.accounts.id)).all())
      .resolves.toEqual([]);
    await expect(db.select().from(schema.accountGroupRates)
      .where(eq(schema.accountGroupRates.accountId, row.accounts.id)).all())
      .resolves.toEqual([expect.objectContaining({ groupKey: 'vip', ratio: 0.8 })]);
  });

  it('clears stale rates from a complete empty snapshot even when there are no tokens', async () => {
    const row = await createAccountRow();
    const rateService = await import('./accountGroupRateService.js');
    await rateService.replaceAccountGroupRates(row.accounts.id, [
      { groupKey: 'legacy', groupName: 'Legacy', ratio: 1.5 },
    ], '2026-07-09T00:00:00.000Z');
    getAdapterMock.mockReturnValue({
      getApiTokens: vi.fn().mockResolvedValue([]),
      getApiToken: vi.fn().mockResolvedValue(null),
      getGroupRates: vi.fn().mockResolvedValue([]),
    });

    const service = await import('./accountPlatformSyncService.js');
    await expect(service.syncAccountPlatformData(row)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'no_upstream_tokens',
      rateSync: { status: 'synced', total: 0 },
    });
    await expect(rateService.listAccountGroupRates(row.accounts.id)).resolves.toEqual([]);
  });

  it('keeps an independent successful rate result when token fetching fails', async () => {
    const row = await createAccountRow();
    getAdapterMock.mockReturnValue({
      getApiTokens: vi.fn().mockRejectedValue(new Error('token endpoint unavailable')),
      getApiToken: vi.fn().mockResolvedValue(null),
      getGroupRates: vi.fn().mockResolvedValue([
        { groupKey: 'vip', groupName: 'VIP', ratio: 0.8 },
      ]),
    });

    const service = await import('./accountPlatformSyncService.js');
    const result = await service.syncAccountPlatformData(row);

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'sync_error',
      message: 'token endpoint unavailable',
      synced: false,
      rateSync: { status: 'synced', total: 1 },
    });
    await expect(db.select().from(schema.accountGroupRates)
      .where(eq(schema.accountGroupRates.accountId, row.accounts.id)).all())
      .resolves.toEqual([expect.objectContaining({ groupKey: 'vip', ratio: 0.8 })]);
  });

  it('preserves stale rates when a non-empty malformed rate snapshot is returned', async () => {
    const row = await createAccountRow();
    const rateService = await import('./accountGroupRateService.js');
    await rateService.replaceAccountGroupRates(row.accounts.id, [
      { groupKey: 'legacy', groupName: 'Legacy', ratio: 1.5 },
    ], '2026-07-09T00:00:00.000Z');
    getAdapterMock.mockReturnValue({
      getApiTokens: vi.fn().mockResolvedValue([]),
      getApiToken: vi.fn().mockResolvedValue(null),
      getGroupRates: vi.fn().mockResolvedValue([
        { groupKey: 'valid', groupName: 'Valid', ratio: 1 },
        { groupKey: 'broken', groupName: 'Broken', ratio: Number.NaN },
      ]),
    });

    const service = await import('./accountPlatformSyncService.js');
    await expect(service.syncAccountPlatformData(row)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'no_upstream_tokens',
      rateSync: { status: 'failed', message: expect.stringMatching(/invalid group rate/i) },
    });
    await expect(rateService.listAccountGroupRates(row.accounts.id)).resolves.toEqual([
      expect.objectContaining({
        groupKey: 'legacy',
        ratio: 1.5,
        lastSyncedAt: '2026-07-09T00:00:00.000Z',
      }),
    ]);
  });

  it('aborts the underlying token request when the timeout expires', async () => {
    vi.useFakeTimers();
    try {
      const row = await createAccountRow();
      let observedSignal: AbortSignal | undefined;
      const getApiTokens = vi.fn((
        _baseUrl: string,
        _accessToken: string,
        _platformUserId?: number,
        signal?: AbortSignal,
      ) => {
        observedSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      getAdapterMock.mockReturnValue({
        getApiTokens,
        getApiToken: vi.fn().mockResolvedValue(null),
      });

      const service = await import('./accountPlatformSyncService.js');
      const resultPromise = service.syncAccountPlatformData(row);
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(resultPromise).resolves.toMatchObject({
        status: 'failed',
        reason: 'sync_error',
      });
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: 'access token changes',
      mutate: async (accountId: number) => {
        await db.update(schema.accounts)
          .set({ accessToken: 'administrator-session-token' })
          .where(eq(schema.accounts.id, accountId))
          .run();
      },
      expectedAccount: { accessToken: 'administrator-session-token' },
    },
    {
      name: 'account is disabled',
      mutate: async (accountId: number) => {
        await db.update(schema.accounts)
          .set({ status: 'disabled' })
          .where(eq(schema.accounts.id, accountId))
          .run();
      },
      expectedAccount: { status: 'disabled' },
    },
    {
      name: 'extra config changes',
      mutate: async (accountId: number) => {
        await db.update(schema.accounts)
          .set({ extraConfig: JSON.stringify({ credentialMode: 'session', platformUserId: 9090 }) })
          .where(eq(schema.accounts.id, accountId))
          .run();
      },
      expectedAccount: {
        extraConfig: JSON.stringify({ credentialMode: 'session', platformUserId: 9090 }),
      },
    },
  ])('rejects a stale token result without writes when $name', async ({ mutate, expectedAccount }) => {
    const row = await createAccountRow();
    await db.update(schema.accounts)
      .set({ apiToken: 'sk-existing-default' })
      .where(eq(schema.accounts.id, row.accounts.id))
      .run();
    await db.insert(schema.accountTokens).values({
      accountId: row.accounts.id,
      name: 'existing default',
      token: 'sk-existing-default',
      tokenGroup: 'default',
      valueStatus: 'ready',
      source: 'manual',
      enabled: true,
      isDefault: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    }).run();
    const beforeTokens = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, row.accounts.id)).all();
    const upstream = deferred<Array<{ name: string; key: string; enabled: boolean }>>();
    const requestStarted = deferred<void>();
    getAdapterMock.mockReturnValue({
      getApiTokens: vi.fn().mockImplementation(() => {
        requestStarted.resolve();
        return upstream.promise;
      }),
      getApiToken: vi.fn().mockResolvedValue(null),
    });
    refreshAccountGroupRatesMock.mockResolvedValueOnce({
      rateSync: { status: 'skipped' as const, reason: 'test' },
      recoveredSession: false,
    });

    const service = await import('./accountPlatformSyncService.js');
    const pending = service.syncAccountPlatformData(row);
    await requestStarted.promise;
    await mutate(row.accounts.id);
    upstream.resolve([{ name: 'stale upstream', key: 'sk-stale-upstream', enabled: true }]);

    await expect(pending).resolves.toMatchObject({
      status: 'skipped',
      reason: 'account_session_changed',
      synced: false,
    });
    await expect(db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, row.accounts.id)).all())
      .resolves.toEqual(beforeTokens);
    await expect(db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, row.accounts.id)).get())
      .resolves.toEqual(expect.objectContaining({
        apiToken: 'sk-existing-default',
        ...expectedAccount,
      }));
  });

  it('recovers an expired session and retries token synchronization once in the same flow', async () => {
    const row = await createAccountRow();
    const recoveredExtraConfig = JSON.stringify({ credentialMode: 'session', platformUserId: 7788 });
    const getApiTokens = vi.fn()
      .mockRejectedValueOnce(new Error('access token expired'))
      .mockResolvedValueOnce([
        { name: 'recovered token', key: 'sk-recovered-token', enabled: true },
      ]);
    getAdapterMock.mockReturnValue({
      getApiTokens,
      getApiToken: vi.fn().mockResolvedValue(null),
      getGroupRates: vi.fn().mockResolvedValue([]),
    });
    refreshAccountGroupRatesMock.mockImplementationOnce(async (activeRow: typeof row) => ({
      rateSync: { status: 'synced' as const, total: 0, syncedAt: new Date().toISOString() },
      recoveredSession: activeRow.accounts.accessToken === 'fresh-session-token',
    }));

    recoverAccountSessionMock.mockImplementationOnce(async () => {
      await db.update(schema.accounts)
        .set({ accessToken: 'fresh-session-token', extraConfig: recoveredExtraConfig })
        .where(eq(schema.accounts.id, row.accounts.id))
        .run();
      return {
        accessToken: 'fresh-session-token',
        extraConfig: recoveredExtraConfig,
        platformUserId: 7788,
      };
    });

    const service = await import('./accountPlatformSyncService.js');
    const result = await service.syncAccountPlatformData(row);

    expect(result).toMatchObject({ status: 'synced', created: 1 });
    expect(getApiTokens).toHaveBeenCalledTimes(2);
    expect(getApiTokens.mock.calls[0]?.[1]).toBe('session-token');
    expect(getApiTokens.mock.calls[1]?.[1]).toBe('fresh-session-token');
    expect(recoverAccountSessionMock).toHaveBeenCalledTimes(1);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.objectContaining({
          accessToken: 'fresh-session-token',
          extraConfig: recoveredExtraConfig,
        }),
      }),
      { sessionRecoveryAttempted: true, signal: expect.any(AbortSignal) },
    );
  });

  it('reloads a competing recovery winner and uses it for the single token retry and rate sync', async () => {
    const row = await createAccountRow();
    const winnerExtraConfig = JSON.stringify({ credentialMode: 'session', platformUserId: 7788 });
    const getApiTokens = vi.fn()
      .mockRejectedValueOnce(new Error('access token expired'))
      .mockResolvedValueOnce([
        { name: 'winner token', key: 'sk-winner-token', enabled: true },
      ]);
    getAdapterMock.mockReturnValue({
      getApiTokens,
      getApiToken: vi.fn().mockResolvedValue(null),
    });
    recoverAccountSessionMock.mockImplementationOnce(async () => {
      await db.update(schema.accounts)
        .set({ accessToken: 'winner-session-token', extraConfig: winnerExtraConfig })
        .where(eq(schema.accounts.id, row.accounts.id))
        .run();
      return null;
    });
    refreshAccountGroupRatesMock.mockResolvedValueOnce({
      rateSync: { status: 'synced' as const, total: 0, syncedAt: '2026-07-11T00:00:00.000Z' },
      recoveredSession: false,
    });

    const service = await import('./accountPlatformSyncService.js');
    await expect(service.syncAccountPlatformData(row)).resolves.toMatchObject({
      status: 'synced',
      created: 1,
    });

    expect(recoverAccountSessionMock).toHaveBeenCalledTimes(1);
    expect(getApiTokens).toHaveBeenCalledTimes(2);
    expect(getApiTokens.mock.calls[1]?.[1]).toBe('winner-session-token');
    expect(getApiTokens.mock.calls[1]?.[2]).toBe(7788);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.objectContaining({
          accessToken: 'winner-session-token',
          extraConfig: winnerExtraConfig,
        }),
      }),
      { sessionRecoveryAttempted: true, signal: expect.any(AbortSignal) },
    );
  });

  it('reloads a CAS winner without retrying when the session identity is unchanged', async () => {
    const row = await createAccountRow();
    const getApiTokens = vi.fn().mockRejectedValueOnce(new Error('access token expired'));
    getAdapterMock.mockReturnValue({
      getApiTokens,
      getApiToken: vi.fn().mockResolvedValue(null),
    });
    recoverAccountSessionMock.mockImplementationOnce(async () => {
      await db.update(schema.accounts)
        .set({ apiToken: 'winner-local-api-token' })
        .where(eq(schema.accounts.id, row.accounts.id))
        .run();
      return null;
    });
    refreshAccountGroupRatesMock.mockResolvedValueOnce({
      rateSync: { status: 'failed' as const, message: 'access token expired' },
      recoveredSession: false,
      failureKind: 'auth' as const,
    });

    const service = await import('./accountPlatformSyncService.js');
    await service.syncAccountPlatformData(row);

    expect(getApiTokens).toHaveBeenCalledTimes(1);
    expect(recoverAccountSessionMock).toHaveBeenCalledTimes(1);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.objectContaining({ apiToken: 'winner-local-api-token' }),
      }),
      { sessionRecoveryAttempted: true, signal: expect.any(AbortSignal) },
    );
  });

  it('stops after a competing recovery deletes the account', async () => {
    const row = await createAccountRow();
    const getApiTokens = vi.fn().mockRejectedValueOnce(new Error('access token expired'));
    getAdapterMock.mockReturnValue({
      getApiTokens,
      getApiToken: vi.fn().mockResolvedValue(null),
    });
    recoverAccountSessionMock.mockImplementationOnce(async () => {
      await db.delete(schema.accounts)
        .where(eq(schema.accounts.id, row.accounts.id))
        .run();
      return null;
    });

    const service = await import('./accountPlatformSyncService.js');
    await expect(service.syncAccountPlatformData(row)).resolves.toMatchObject({
      status: 'failed',
      reason: 'sync_error',
      rateSync: { status: 'skipped', reason: 'account_deleted' },
    });

    expect(getApiTokens).toHaveBeenCalledTimes(1);
    expect(recoverAccountSessionMock).toHaveBeenCalledTimes(1);
    expect(refreshAccountGroupRatesMock).not.toHaveBeenCalled();
  });

  it.each([
    'HTTP 403: forbidden by role',
    'token sync timeout (15s)',
    'HTTP 429: rate limited',
    'fetch failed: ECONNRESET',
    'upstream returned an invalid api token list',
  ])('does not recover or retry tokens for non-session failure: %s', async (message) => {
    const row = await createAccountRow();
    const getApiTokens = vi.fn().mockRejectedValue(new Error(message));
    getAdapterMock.mockReturnValue({
      getApiTokens,
      getApiToken: vi.fn().mockResolvedValue(null),
      getGroupRates: vi.fn().mockResolvedValue([]),
    });
    refreshAccountGroupRatesMock.mockResolvedValueOnce({
      rateSync: { status: 'failed' as const, message },
      recoveredSession: false,
      failureKind: 'upstream' as const,
    });

    const service = await import('./accountPlatformSyncService.js');
    await expect(service.syncAccountPlatformData(row)).resolves.toMatchObject({
      status: 'failed',
      message,
    });

    expect(getApiTokens).toHaveBeenCalledTimes(1);
    expect(recoverAccountSessionMock).not.toHaveBeenCalled();
  });

  it('caps a recovered token retry at one attempt', async () => {
    const row = await createAccountRow();
    const getApiTokens = vi.fn().mockRejectedValue(new Error('access token expired'));
    getAdapterMock.mockReturnValue({
      getApiTokens,
      getApiToken: vi.fn().mockResolvedValue(null),
      getGroupRates: vi.fn().mockResolvedValue([]),
    });
    recoverAccountSessionMock.mockResolvedValueOnce({
      accessToken: 'fresh-session-token',
      extraConfig: null,
    });
    refreshAccountGroupRatesMock.mockResolvedValueOnce({
      rateSync: { status: 'failed' as const, message: 'access token expired' },
      recoveredSession: false,
      failureKind: 'auth' as const,
    });

    const service = await import('./accountPlatformSyncService.js');
    await expect(service.syncAccountPlatformData(row)).resolves.toMatchObject({
      status: 'failed',
      message: 'access token expired',
    });

    expect(getApiTokens).toHaveBeenCalledTimes(2);
    expect(recoverAccountSessionMock).toHaveBeenCalledTimes(1);
  });

  it('uses one 30-second owner budget across token recovery and retry', async () => {
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof import('./accountPlatformSyncService.js')['syncAccountPlatformData']>> | undefined;
    try {
      const row = await createAccountRow();
      let retrySignal: AbortSignal | undefined;
      const getApiTokens = vi.fn((
        _baseUrl: string,
        _accessToken: string,
        _platformUserId?: number,
        signal?: AbortSignal,
      ) => {
        if (getApiTokens.mock.calls.length === 1) {
          return new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('access token expired')), 14_000);
          });
        }
        retrySignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      getAdapterMock.mockReturnValue({
        getApiTokens,
        getApiToken: vi.fn().mockResolvedValue(null),
      });
      let recoverySignal: AbortSignal | undefined;
      recoverAccountSessionMock.mockImplementationOnce((
        _account: unknown,
        _site: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        recoverySignal = options?.signal;
        return new Promise((resolve) => {
          setTimeout(() => resolve({ accessToken: 'fresh-session-token', extraConfig: null }), 14_000);
        });
      });

      const service = await import('./accountPlatformSyncService.js');
      const resultPromise = service.syncAccountPlatformData(row);
      void resultPromise.then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(result).toMatchObject({ status: 'failed', reason: 'sync_error' });
      expect(getApiTokens).toHaveBeenCalledTimes(2);
      expect(recoverySignal).toBeInstanceOf(AbortSignal);
      expect(recoverySignal?.aborted).toBe(true);
      expect(retrySignal).toBeInstanceOf(AbortSignal);
      expect(retrySignal?.aborted).toBe(true);
    } finally {
      await vi.advanceTimersByTimeAsync(20_000);
      vi.useRealTimers();
    }
  });
});
