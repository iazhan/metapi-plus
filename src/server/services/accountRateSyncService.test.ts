import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDataDir, type TestDataDir } from '../test-fixtures/testDataDir.js';

const mocks = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  refreshSub2ApiSession: vi.fn(),
  reloginSession: vi.fn(),
  persistenceError: null as Error | null,
}));

vi.mock('./platforms/index.js', () => ({
  getAdapter: (...args: unknown[]) => mocks.getAdapter(...args),
}));

vi.mock('./sub2apiRefreshSingleflight.js', () => ({
  refreshSub2ApiManagedSessionSingleflight: (...args: unknown[]) => mocks.refreshSub2ApiSession(...args),
}));

vi.mock('./accountLoginSessionService.js', () => ({
  reloginAccountSession: (...args: unknown[]) => mocks.reloginSession(...args),
}));

vi.mock('./accountGroupRateService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./accountGroupRateService.js')>();
  return {
    ...actual,
    replaceAccountGroupRates: (...args: Parameters<typeof actual.replaceAccountGroupRates>) => {
      if (mocks.persistenceError) {
        return Promise.reject(mocks.persistenceError);
      }
      return actual.replaceAccountGroupRates(...args);
    },
    replaceAccountGroupRatesForSession: (...args: Parameters<typeof actual.replaceAccountGroupRatesForSession>) => {
      if (mocks.persistenceError) {
        return Promise.reject(mocks.persistenceError);
      }
      return actual.replaceAccountGroupRatesForSession(...args);
    },
  };
});

type DbModule = typeof import('../db/index.js');
type RateServiceModule = typeof import('./accountRateSyncService.js');
type RateStoreModule = typeof import('./accountGroupRateService.js');

describe('accountRateSyncService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let refreshAccountGroupRates: RateServiceModule['refreshAccountGroupRates'];
  let accountRateSyncTimeoutMs: RateServiceModule['ACCOUNT_RATE_SYNC_TIMEOUT_MS'];
  let replaceAccountGroupRates: RateStoreModule['replaceAccountGroupRates'];
  let listAccountGroupRates: RateStoreModule['listAccountGroupRates'];
  let testDataDir: TestDataDir;
  let rowSequence = 0;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-account-rate-sync-');
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;

    const rateStore = await import('./accountGroupRateService.js');
    replaceAccountGroupRates = rateStore.replaceAccountGroupRates;
    listAccountGroupRates = rateStore.listAccountGroupRates;

    const rateService = await import('./accountRateSyncService.js');
    refreshAccountGroupRates = rateService.refreshAccountGroupRates;
    accountRateSyncTimeoutMs = rateService.ACCOUNT_RATE_SYNC_TIMEOUT_MS;
  });

  beforeEach(async () => {
    vi.useRealTimers();
    mocks.getAdapter.mockReset();
    mocks.refreshSub2ApiSession.mockReset();
    mocks.reloginSession.mockReset();
    mocks.persistenceError = null;
    rowSequence = 0;

    await db.delete(schema.accountGroupRates).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await testDataDir.cleanup(closeDbConnections);
  });

  async function createAccountRow(input: {
    platform?: string;
    siteStatus?: string;
    accountStatus?: string;
    accessToken?: string;
    apiToken?: string | null;
    username?: string;
    extraConfig?: string | null;
  } = {}) {
    rowSequence += 1;
    const site = await db.insert(schema.sites).values({
      name: `Rate Site ${rowSequence}`,
      url: `https://rates-${rowSequence}.example.com`,
      platform: input.platform ?? 'new-api',
      status: input.siteStatus ?? 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: input.username ?? `rate-user-${rowSequence}`,
      accessToken: input.accessToken ?? 'active-token',
      apiToken: input.apiToken ?? null,
      status: input.accountStatus ?? 'active',
      extraConfig: input.extraConfig === undefined
        ? JSON.stringify({ credentialMode: 'session' })
        : input.extraConfig,
    }).returning().get();
    return { accounts: account, sites: site };
  }

  async function seedLegacyRate(accountId: number) {
    await replaceAccountGroupRates(accountId, [
      { groupKey: 'legacy', groupName: 'Legacy', ratio: 1.5 },
    ], '2026-07-09T00:00:00.000Z');
  }

  async function expectLegacyRate(accountId: number) {
    await expect(listAccountGroupRates(accountId)).resolves.toEqual([
      expect.objectContaining({
        groupKey: 'legacy',
        ratio: 1.5,
        lastSyncedAt: '2026-07-09T00:00:00.000Z',
      }),
    ]);
  }

  async function accountStatus(accountId: number) {
    const account = await db.select({ status: schema.accounts.status })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    return account?.status;
  }

  async function persistRecoveredSession(
    accountId: number,
    accessToken: string,
    extraConfig: string | null,
    status = 'active',
  ) {
    await db.update(schema.accounts).set({
      accessToken,
      extraConfig,
      status,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.accounts.id, accountId)).run();
  }

  it('persists a complete active rate snapshot', async () => {
    const row = await createAccountRow();
    await seedLegacyRate(row.accounts.id);
    const getGroupRates = vi.fn().mockResolvedValue([
      { groupKey: 'vip', groupName: 'VIP', ratio: 0.8 },
    ]);
    mocks.getAdapter.mockReturnValue({ getGroupRates });

    const outcome = await refreshAccountGroupRates(row);

    expect(outcome).toMatchObject({
      rateSync: { status: 'synced', total: 1, syncedAt: expect.any(String) },
      recoveredSession: false,
    });
    expect(getGroupRates).toHaveBeenCalledWith(
      row.sites.url,
      'active-token',
      undefined,
      expect.any(AbortSignal),
    );
    await expect(listAccountGroupRates(row.accounts.id)).resolves.toEqual([
      expect.objectContaining({ groupKey: 'vip', groupName: 'VIP', ratio: 0.8 }),
    ]);
  });

  it('clears stale rates after a complete empty snapshot', async () => {
    const row = await createAccountRow();
    await seedLegacyRate(row.accounts.id);
    mocks.getAdapter.mockReturnValue({
      getGroupRates: vi.fn().mockResolvedValue([]),
    });

    await expect(refreshAccountGroupRates(row)).resolves.toMatchObject({
      rateSync: { status: 'synced', total: 0 },
      recoveredSession: false,
    });
    await expect(listAccountGroupRates(row.accounts.id)).resolves.toEqual([]);
  });

  it('preserves the previous snapshot after an upstream failure', async () => {
    const row = await createAccountRow();
    await seedLegacyRate(row.accounts.id);
    mocks.getAdapter.mockReturnValue({
      getGroupRates: vi.fn().mockRejectedValue(new Error('upstream unavailable')),
    });

    await expect(refreshAccountGroupRates(row)).resolves.toMatchObject({
      rateSync: { status: 'failed', message: 'upstream unavailable' },
      recoveredSession: false,
      failureKind: 'upstream',
    });
    await expectLegacyRate(row.accounts.id);
  });

  it('rejects an invalid rate without replacing the previous snapshot', async () => {
    const row = await createAccountRow();
    await seedLegacyRate(row.accounts.id);
    mocks.getAdapter.mockReturnValue({
      getGroupRates: vi.fn().mockResolvedValue([
        { groupKey: 'broken', groupName: 'Broken', ratio: Number.NaN },
      ]),
    });

    await expect(refreshAccountGroupRates(row)).resolves.toMatchObject({
      rateSync: { status: 'failed', message: expect.stringMatching(/invalid group rate/i) },
      recoveredSession: false,
      failureKind: 'invalid_response',
    });
    await expectLegacyRate(row.accounts.id);
  });

  it('skips ineligible rows and reports unsupported adapters defensively', async () => {
    const adapterRateMethod = vi.fn();
    mocks.getAdapter.mockReturnValue({ getGroupRates: adapterRateMethod });
    const apiKeyRow = await createAccountRow({
      accessToken: '',
      apiToken: 'sk-api-key',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    });
    const disabledAccountRow = await createAccountRow({ accountStatus: 'disabled' });
    const disabledSiteRow = await createAccountRow({ siteStatus: 'disabled' });

    await expect(refreshAccountGroupRates(apiKeyRow)).resolves.toEqual({
      rateSync: { status: 'skipped', reason: 'apikey_connection' },
      recoveredSession: false,
    });
    await expect(refreshAccountGroupRates(disabledAccountRow)).resolves.toEqual({
      rateSync: { status: 'skipped', reason: 'account_disabled' },
      recoveredSession: false,
    });
    await expect(refreshAccountGroupRates(disabledSiteRow)).resolves.toEqual({
      rateSync: { status: 'skipped', reason: 'site_disabled' },
      recoveredSession: false,
    });
    expect(adapterRateMethod).not.toHaveBeenCalled();
    expect(mocks.getAdapter).not.toHaveBeenCalled();

    const unsupportedRow = await createAccountRow();
    mocks.getAdapter.mockReturnValue({});
    await expect(refreshAccountGroupRates(unsupportedRow)).resolves.toEqual({
      rateSync: { status: 'unsupported' },
      recoveredSession: false,
    });
  });

  it('refreshes an expired Sub2API session before requesting rates', async () => {
    const row = await createAccountRow({
      platform: 'sub2api',
      accountStatus: 'expired',
      accessToken: 'stale-sub2-token',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        sub2apiAuth: { refreshToken: 'stored-refresh-token' },
      }),
    });
    const getGroupRates = vi.fn().mockResolvedValue([
      { groupKey: 'vip', groupName: 'VIP', ratio: 0.8 },
    ]);
    mocks.getAdapter.mockReturnValue({ getGroupRates });
    mocks.refreshSub2ApiSession.mockImplementation(async () => {
      await persistRecoveredSession(row.accounts.id, 'fresh-sub2-token', row.accounts.extraConfig);
      return {
        accessToken: 'fresh-sub2-token',
        extraConfig: row.accounts.extraConfig,
      };
    });

    await expect(refreshAccountGroupRates(row)).resolves.toMatchObject({
      rateSync: { status: 'synced', total: 1 },
      recoveredSession: true,
    });
    expect(mocks.refreshSub2ApiSession).toHaveBeenCalledTimes(1);
    expect(mocks.reloginSession).not.toHaveBeenCalled();
    expect(getGroupRates).toHaveBeenCalledWith(
      row.sites.url,
      'fresh-sub2-token',
      undefined,
      expect.any(AbortSignal),
    );
    await expect(accountStatus(row.accounts.id)).resolves.toBe('active');
  });

  it('relogs an expired New API account before requesting rates', async () => {
    const { encryptAccountPassword } = await import('./accountCredentialService.js');
    const row = await createAccountRow({
      accountStatus: 'expired',
      accessToken: 'stale-new-api-token',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        autoRelogin: {
          username: 'rate-login@example.com',
          passwordCipher: encryptAccountPassword('secret-password'),
        },
      }),
    });
    const getGroupRates = vi.fn().mockResolvedValue([
      { groupKey: 'vip', groupName: 'VIP', ratio: 0.8 },
    ]);
    mocks.getAdapter.mockReturnValue({ getGroupRates });
    mocks.reloginSession.mockImplementation(async () => {
      await persistRecoveredSession(row.accounts.id, 'fresh-new-api-token', row.accounts.extraConfig);
      return {
        accessToken: 'fresh-new-api-token',
        extraConfig: row.accounts.extraConfig,
        platformUserId: 11494,
      };
    });

    await expect(refreshAccountGroupRates(row)).resolves.toMatchObject({
      rateSync: { status: 'synced', total: 1 },
      recoveredSession: true,
    });
    expect(mocks.reloginSession).toHaveBeenCalledTimes(1);
    expect(getGroupRates).toHaveBeenCalledWith(
      row.sites.url,
      'fresh-new-api-token',
      11494,
      expect.any(AbortSignal),
    );
    await expect(accountStatus(row.accounts.id)).resolves.toBe('active');
  });

  it('recovers once and retries an active account after an auth failure', async () => {
    const row = await createAccountRow();
    const getGroupRates = vi.fn()
      .mockRejectedValueOnce(new Error('unauthorized'))
      .mockResolvedValueOnce([{ groupKey: 'vip', groupName: 'VIP', ratio: 0.8 }]);
    mocks.getAdapter.mockReturnValue({ getGroupRates });
    mocks.reloginSession.mockImplementation(async () => {
      await persistRecoveredSession(row.accounts.id, 'fresh-token', row.accounts.extraConfig);
      return {
        accessToken: 'fresh-token',
        extraConfig: row.accounts.extraConfig,
      };
    });

    await expect(refreshAccountGroupRates(row)).resolves.toMatchObject({
      rateSync: { status: 'synced', total: 1 },
      recoveredSession: true,
    });
    expect(getGroupRates).toHaveBeenCalledTimes(2);
    expect(getGroupRates.mock.calls[0]?.[1]).toBe('active-token');
    expect(getGroupRates.mock.calls[1]?.[1]).toBe('fresh-token');
    expect(mocks.reloginSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    { scenario: 'timeout', expectedKind: 'timeout' },
    { scenario: 'rate limit', expectedKind: 'upstream' },
    { scenario: 'maintenance html', expectedKind: 'invalid_response' },
    { scenario: 'invalid array', expectedKind: 'invalid_response' },
  ] as const)('does not recover for a $scenario failure', async ({ scenario, expectedKind }) => {
    const row = await createAccountRow();
    await seedLegacyRate(row.accounts.id);
    const getGroupRates = vi.fn();
    if (scenario === 'timeout') {
      getGroupRates.mockImplementation(() => new Promise(() => {}));
      vi.useFakeTimers();
    } else if (scenario === 'rate limit') {
      getGroupRates.mockRejectedValue(new Error('HTTP 429: rate limit exceeded'));
    } else if (scenario === 'maintenance html') {
      getGroupRates.mockRejectedValue(new Error('<html><title>Maintenance</title></html>'));
    } else {
      getGroupRates.mockResolvedValue({ rates: [] });
    }
    mocks.getAdapter.mockReturnValue({ getGroupRates });

    const outcomePromise = refreshAccountGroupRates(row);
    if (scenario === 'timeout') {
      await vi.advanceTimersByTimeAsync(accountRateSyncTimeoutMs);
    }
    const outcome = await outcomePromise;
    vi.useRealTimers();

    expect(outcome).toMatchObject({
      rateSync: { status: 'failed' },
      recoveredSession: false,
      failureKind: expectedKind,
    });
    expect(mocks.refreshSub2ApiSession).not.toHaveBeenCalled();
    expect(mocks.reloginSession).not.toHaveBeenCalled();
    await expectLegacyRate(row.accounts.id);
  });

  it('aborts the underlying rate request when the timeout expires', async () => {
    const row = await createAccountRow();
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const getGroupRates = vi.fn((
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
    mocks.getAdapter.mockReturnValue({ getGroupRates });

    const outcomePromise = refreshAccountGroupRates(row);
    await vi.advanceTimersByTimeAsync(accountRateSyncTimeoutMs);
    await expect(outcomePromise).resolves.toMatchObject({
      rateSync: { status: 'failed' },
      failureKind: 'timeout',
    });

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(mocks.reloginSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('marks the account expired when an auth failure cannot be recovered', async () => {
    const row = await createAccountRow({
      platform: 'sub2api',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        sub2apiAuth: { refreshToken: 'stored-refresh-token' },
      }),
    });
    await seedLegacyRate(row.accounts.id);
    const getGroupRates = vi.fn().mockRejectedValue(new Error('invalid access token'));
    mocks.getAdapter.mockReturnValue({ getGroupRates });
    mocks.refreshSub2ApiSession.mockRejectedValue(new Error('refresh rejected'));
    mocks.reloginSession.mockResolvedValue(null);

    await expect(refreshAccountGroupRates(row)).resolves.toMatchObject({
      rateSync: { status: 'failed', message: 'invalid access token' },
      recoveredSession: false,
      failureKind: 'auth',
    });
    expect(getGroupRates).toHaveBeenCalledTimes(1);
    expect(mocks.refreshSub2ApiSession).toHaveBeenCalledTimes(1);
    expect(mocks.reloginSession).toHaveBeenCalledTimes(1);
    await expect(accountStatus(row.accounts.id)).resolves.toBe('expired');
    await expectLegacyRate(row.accounts.id);
  });

  it('does not expire a disabled account after an in-flight auth failure', async () => {
    const row = await createAccountRow();
    await seedLegacyRate(row.accounts.id);
    let rejectRates!: (reason?: unknown) => void;
    const getGroupRates = vi.fn(() => new Promise((_resolve, reject) => {
      rejectRates = reject;
    }));
    mocks.getAdapter.mockReturnValue({ getGroupRates });
    mocks.reloginSession.mockResolvedValue(null);

    const refresh = refreshAccountGroupRates(row);
    await vi.waitFor(() => expect(getGroupRates).toHaveBeenCalledTimes(1));
    await db.update(schema.accounts).set({
      status: 'disabled',
      accessToken: 'admin-session-token',
      updatedAt: '2026-07-11T00:04:00.000Z',
    }).where(eq(schema.accounts.id, row.accounts.id)).run();
    rejectRates(new Error('unauthorized'));

    await expect(refresh).resolves.toMatchObject({
      rateSync: { status: 'failed' },
      failureKind: 'auth',
    });
    await expect(db.select().from(schema.accounts).where(eq(schema.accounts.id, row.accounts.id)).get())
      .resolves.toMatchObject({ status: 'disabled', accessToken: 'admin-session-token' });
    await expectLegacyRate(row.accounts.id);
  });

  it('discards an in-flight rate snapshot when the account session changes', async () => {
    const row = await createAccountRow();
    await seedLegacyRate(row.accounts.id);
    let resolveRates!: (rates: unknown[]) => void;
    const getGroupRates = vi.fn(() => new Promise((resolve) => {
      resolveRates = resolve;
    }));
    mocks.getAdapter.mockReturnValue({ getGroupRates });

    const refresh = refreshAccountGroupRates(row);
    await vi.waitFor(() => expect(getGroupRates).toHaveBeenCalledTimes(1));
    await db.update(schema.accounts).set({
      status: 'disabled',
      accessToken: 'newer-session-token',
      updatedAt: '2026-07-11T00:05:00.000Z',
    }).where(eq(schema.accounts.id, row.accounts.id)).run();
    resolveRates([{ groupKey: 'vip', groupName: 'VIP', ratio: 0.8 }]);

    await expect(refresh).resolves.toEqual({
      rateSync: { status: 'skipped', reason: 'account_session_changed' },
      recoveredSession: false,
    });
    await expectLegacyRate(row.accounts.id);
  });

  it('discards an in-flight rate snapshot when session configuration changes without rotating the token', async () => {
    const row = await createAccountRow({
      extraConfig: JSON.stringify({ credentialMode: 'session', proxyUrl: 'https://old-proxy.example.com' }),
    });
    await seedLegacyRate(row.accounts.id);
    let resolveRates!: (rates: unknown[]) => void;
    const getGroupRates = vi.fn(() => new Promise((resolve) => {
      resolveRates = resolve;
    }));
    mocks.getAdapter.mockReturnValue({ getGroupRates });

    const refresh = refreshAccountGroupRates(row);
    await vi.waitFor(() => expect(getGroupRates).toHaveBeenCalledTimes(1));
    const newerExtraConfig = JSON.stringify({
      credentialMode: 'session',
      proxyUrl: 'https://new-proxy.example.com',
      platformUserId: 7788,
    });
    await db.update(schema.accounts).set({
      extraConfig: newerExtraConfig,
      updatedAt: '2026-07-11T00:05:30.000Z',
    }).where(eq(schema.accounts.id, row.accounts.id)).run();
    resolveRates([{ groupKey: 'vip', groupName: 'VIP', ratio: 0.8 }]);

    await expect(refresh).resolves.toEqual({
      rateSync: { status: 'skipped', reason: 'account_session_changed' },
      recoveredSession: false,
    });
    await expectLegacyRate(row.accounts.id);
    await expect(db.select().from(schema.accounts).where(eq(schema.accounts.id, row.accounts.id)).get())
      .resolves.toMatchObject({ extraConfig: newerExtraConfig });
  });

  it('rolls back a new snapshot when expired-account activation fails', async () => {
    const row = await createAccountRow({
      accountStatus: 'expired',
      accessToken: 'stale-token',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    await seedLegacyRate(row.accounts.id);
    mocks.reloginSession.mockResolvedValue(null);
    mocks.getAdapter.mockReturnValue({
      getGroupRates: vi.fn().mockResolvedValue([
        { groupKey: 'vip', groupName: 'VIP', ratio: 0.8 },
      ]),
    });

    await db.run(sql.raw(`
      CREATE TRIGGER fail_rate_account_activation
      BEFORE UPDATE OF status ON accounts
      WHEN OLD.id = ${row.accounts.id} AND NEW.status = 'active'
      BEGIN
        SELECT RAISE(ABORT, 'forced account activation failure');
      END
    `));
    try {
      const outcome = await refreshAccountGroupRates(row);
      await expect(accountStatus(row.accounts.id)).resolves.toBe('expired');
      await expectLegacyRate(row.accounts.id);
      expect(outcome).toMatchObject({
        rateSync: { status: 'failed' },
        failureKind: 'storage',
      });
    } finally {
      await db.run(sql`DROP TRIGGER IF EXISTS fail_rate_account_activation`);
    }
  });

  it('attempts recovery only once per refresh for an expired account', async () => {
    const row = await createAccountRow({
      platform: 'sub2api',
      accountStatus: 'expired',
      accessToken: 'stale-token',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        sub2apiAuth: { refreshToken: 'stored-refresh-token' },
      }),
    });
    await seedLegacyRate(row.accounts.id);
    mocks.refreshSub2ApiSession.mockResolvedValue({
      accessToken: 'fresh-but-rejected-token',
      extraConfig: row.accounts.extraConfig,
    });
    const getGroupRates = vi.fn().mockRejectedValue(new Error('invalid access token'));
    mocks.getAdapter.mockReturnValue({ getGroupRates });

    await expect(refreshAccountGroupRates(row)).resolves.toMatchObject({
      rateSync: { status: 'failed', message: 'invalid access token' },
      recoveredSession: true,
      failureKind: 'auth',
    });
    expect(mocks.refreshSub2ApiSession).toHaveBeenCalledTimes(1);
    expect(mocks.reloginSession).not.toHaveBeenCalled();
    expect(getGroupRates).toHaveBeenCalledTimes(1);
    await expect(accountStatus(row.accounts.id)).resolves.toBe('expired');
    await expectLegacyRate(row.accounts.id);
  });

  it('classifies persistence failures as storage and preserves the old snapshot', async () => {
    const row = await createAccountRow();
    await seedLegacyRate(row.accounts.id);
    mocks.getAdapter.mockReturnValue({
      getGroupRates: vi.fn().mockResolvedValue([
        { groupKey: 'vip', groupName: 'VIP', ratio: 0.8 },
      ]),
    });
    mocks.persistenceError = new Error('database write failed');

    await expect(refreshAccountGroupRates(row)).resolves.toMatchObject({
      rateSync: { status: 'failed', message: 'database write failed' },
      recoveredSession: false,
      failureKind: 'storage',
    });
    expect(mocks.refreshSub2ApiSession).not.toHaveBeenCalled();
    expect(mocks.reloginSession).not.toHaveBeenCalled();
    mocks.persistenceError = null;
    await expectLegacyRate(row.accounts.id);
  });

  it('does not recover when a storage failure contains auth-like text', async () => {
    const row = await createAccountRow();
    await seedLegacyRate(row.accounts.id);
    mocks.getAdapter.mockReturnValue({
      getGroupRates: vi.fn().mockResolvedValue([
        { groupKey: 'vip', groupName: 'VIP', ratio: 0.8 },
      ]),
    });
    mocks.persistenceError = new Error('database unauthorized write failed');

    await expect(refreshAccountGroupRates(row)).resolves.toMatchObject({
      rateSync: { status: 'failed', message: 'database unauthorized write failed' },
      recoveredSession: false,
      failureKind: 'storage',
    });
    expect(mocks.refreshSub2ApiSession).not.toHaveBeenCalled();
    expect(mocks.reloginSession).not.toHaveBeenCalled();
    mocks.persistenceError = null;
    await expectLegacyRate(row.accounts.id);
  });

  it('does not expire a recovered account when retry storage fails with auth-like text', async () => {
    const row = await createAccountRow();
    await seedLegacyRate(row.accounts.id);
    const getGroupRates = vi.fn()
      .mockRejectedValueOnce(new Error('unauthorized'))
      .mockResolvedValueOnce([{ groupKey: 'vip', groupName: 'VIP', ratio: 0.8 }]);
    mocks.getAdapter.mockReturnValue({ getGroupRates });
    mocks.reloginSession.mockImplementation(async () => {
      await persistRecoveredSession(row.accounts.id, 'fresh-token', row.accounts.extraConfig);
      return {
        accessToken: 'fresh-token',
        extraConfig: row.accounts.extraConfig,
      };
    });
    mocks.persistenceError = new Error('database unauthorized write failed');

    await expect(refreshAccountGroupRates(row)).resolves.toMatchObject({
      rateSync: { status: 'failed', message: 'database unauthorized write failed' },
      recoveredSession: true,
      failureKind: 'storage',
    });
    expect(getGroupRates).toHaveBeenCalledTimes(2);
    expect(mocks.reloginSession).toHaveBeenCalledTimes(1);
    await expect(accountStatus(row.accounts.id)).resolves.toBe('active');
    mocks.persistenceError = null;
    await expectLegacyRate(row.accounts.id);
  });
});
