import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestDataDir, type TestDataDir } from '../test-fixtures/testDataDir.js';

const refreshAccountGroupRatesMock = vi.hoisted(() => vi.fn());
const eventInsertFailures = vi.hoisted(() => ({ remaining: 0, message: '' }));

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return {
    ...actual,
    db: new Proxy(actual.db, {
      get(target, property, receiver) {
        if (property === 'insert') {
          return (table: unknown) => {
            if (table === actual.schema.events && eventInsertFailures.remaining > 0) {
              eventInsertFailures.remaining -= 1;
              return { values: () => ({ run: async () => { throw new Error(eventInsertFailures.message); } }) };
            }
            return target.insert(table as never);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
});

vi.mock('./accountRateSyncService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./accountRateSyncService.js')>();
  return {
    ...actual,
    refreshAccountGroupRates: (...args: Parameters<typeof actual.refreshAccountGroupRates>) => (
      refreshAccountGroupRatesMock(...args)
    ),
  };
});

type DbModule = typeof import('../db/index.js');
type SchedulerModule = typeof import('./accountRateRefreshScheduler.js');
type ConfigModule = typeof import('../config.js');

const MINUTE_MS = 60_000;

function syncedOutcome() {
  return {
    rateSync: { status: 'synced' as const, total: 1, syncedAt: '2026-07-11T00:00:00.000Z' },
    recoveredSession: false,
  };
}

function failedOutcome(message = 'upstream failure', failureKind: 'auth' | 'timeout' | 'invalid_response' | 'upstream' | 'storage' = 'upstream') {
  return {
    rateSync: { status: 'failed' as const, message },
    recoveredSession: false,
    failureKind,
  };
}

describe('accountRateRefreshScheduler', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let scheduler: SchedulerModule;
  let config: ConfigModule['config'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-account-rate-refresh-scheduler-');
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    ({ config } = await import('../config.js'));
    scheduler = await import('./accountRateRefreshScheduler.js');
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    refreshAccountGroupRatesMock.mockReset();
    eventInsertFailures.remaining = 0;
    eventInsertFailures.message = '';
    config.accountGroupRateRefreshEnabled = true;
    config.accountGroupRateRefreshIntervalMinutes = 30;
    await scheduler.__resetAccountRateRefreshSchedulerForTests();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterEach(async () => {
    await scheduler.__resetAccountRateRefreshSchedulerForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterAll(async () => {
    await testDataDir.cleanup(closeDbConnections);
  });

  async function createSite(input: Partial<typeof schema.sites.$inferInsert> = {}) {
    return await db.insert(schema.sites).values({
      name: input.name ?? `site-${Math.random()}`,
      url: input.url ?? `https://rate-${Math.random()}.example.com`,
      platform: input.platform ?? 'new-api',
      status: input.status ?? 'active',
      ...input,
    }).returning().get();
  }

  async function createAccount(siteId: number, input: Partial<typeof schema.accounts.$inferInsert> = {}) {
    return await db.insert(schema.accounts).values({
      siteId,
      username: input.username ?? `account-${Math.random()}`,
      accessToken: input.accessToken ?? 'session-token',
      status: input.status ?? 'active',
      ...input,
    }).returning().get();
  }

  it('selects active and expired session accounts while counting excluded rows as skipped', async () => {
    const activeSite = await createSite();
    const disabledSite = await createSite({ status: 'disabled' });
    const active = await createAccount(activeSite.id, { username: 'active-session', status: 'active' });
    const expired = await createAccount(activeSite.id, { username: 'expired-session', status: 'expired' });
    await createAccount(activeSite.id, { username: 'disabled-account', status: 'disabled' });
    await createAccount(disabledSite.id, { username: 'disabled-site', status: 'active' });
    const apiKeyOnly = await createAccount(activeSite.id, {
      username: 'api-key-only',
      accessToken: '',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    });
    refreshAccountGroupRatesMock.mockImplementation((row) => Promise.resolve(
      row.accounts.username === 'api-key-only'
        ? { rateSync: { status: 'skipped' as const, reason: 'apikey_connection' }, recoveredSession: false }
        : syncedOutcome(),
    ));

    const result = await scheduler.executeAccountRateRefreshPass({ nowMs: 0 });

    expect(refreshAccountGroupRatesMock.mock.calls.map((call) => call[0].accounts.id).sort((left, right) => left - right))
      .toEqual([active.id, expired.id, apiKeyOnly.id].sort((left, right) => left - right));
    expect(result).toMatchObject({ scanned: 5, candidates: 3, synced: 2, skipped: 3, deferred: 0, failed: 0 });
  });

  it('limits refresh workers to exactly three concurrent calls', async () => {
    vi.useRealTimers();
    const site = await createSite();
    for (let index = 0; index < 5; index += 1) {
      await createAccount(site.id, { username: `concurrent-${index}` });
    }
    const resolvers: Array<() => void> = [];
    refreshAccountGroupRatesMock.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(() => resolve(syncedOutcome()));
    }));

    const pass = scheduler.executeAccountRateRefreshPass({ nowMs: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);

    resolvers.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(4);

    while (resolvers.length > 0) resolvers.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    while (resolvers.length > 0) resolvers.shift()?.();
    await expect(pass).resolves.toMatchObject({ candidates: 5, synced: 5, failed: 0 });
  });

  it('isolates one failed account from a succeeding account', async () => {
    const site = await createSite();
    const failed = await createAccount(site.id, { username: 'failed' });
    const synced = await createAccount(site.id, { username: 'synced' });
    refreshAccountGroupRatesMock.mockImplementation((row) => (
      Promise.resolve(row.accounts.id === failed.id ? failedOutcome() : syncedOutcome())
    ));

    const result = await scheduler.executeAccountRateRefreshPass({ nowMs: 0 });

    expect(result).toMatchObject({ failed: 1, synced: 1 });
    expect(result.failedAccountIds).toEqual([failed.id]);
    expect(result.syncedAccountIds).toEqual([synced.id]);
  });

  it('contains a rejected account refresh and continues the worker queue safely', async () => {
    const site = await createSite();
    const rejected = await createAccount(site.id, { username: 'rejected' });
    const synced = await createAccount(site.id, { username: 'synced-after-rejection' });
    refreshAccountGroupRatesMock.mockImplementation((row) => (
      row.accounts.id === rejected.id
        ? Promise.reject(new Error('Bearer scheduler-rejection-secret'))
        : Promise.resolve(syncedOutcome())
    ));

    const result = await scheduler.executeAccountRateRefreshPass({ nowMs: 0 });

    expect(result).toMatchObject({ failed: 1, synced: 1 });
    expect(result.failedAccountIds).toEqual([rejected.id]);
    expect(result.syncedAccountIds).toEqual([synced.id]);
    const events = await db.select().from(schema.events).all();
    expect(events).toEqual([
      expect.objectContaining({
        title: '自动倍率刷新失败',
        message: '上游倍率接口请求失败',
      }),
    ]);
    expect(events.map((event) => event.message).join('\n')).not.toContain('scheduler-rejection-secret');
  });

  it('uses the approved capped exponential backoff schedule', () => {
    expect(scheduler.computeAccountRateRefreshBackoffMs(1)).toBe(30 * MINUTE_MS);
    expect(scheduler.computeAccountRateRefreshBackoffMs(2)).toBe(60 * MINUTE_MS);
    expect(scheduler.computeAccountRateRefreshBackoffMs(3)).toBe(2 * 60 * MINUTE_MS);
    expect(scheduler.computeAccountRateRefreshBackoffMs(4)).toBe(6 * 60 * MINUTE_MS);
    expect(scheduler.computeAccountRateRefreshBackoffMs(20)).toBe(6 * 60 * MINUTE_MS);
  });

  it('defers repeated failures until each in-memory backoff deadline', async () => {
    const site = await createSite();
    const account = await createAccount(site.id);
    refreshAccountGroupRatesMock.mockResolvedValue(failedOutcome());

    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 0 })).resolves.toMatchObject({ failed: 1, deferred: 0 });
    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 29 * MINUTE_MS })).resolves.toMatchObject({ failed: 0, deferred: 1, deferredAccountIds: [account.id] });
    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 30 * MINUTE_MS })).resolves.toMatchObject({ failed: 1, deferred: 0 });
    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 89 * MINUTE_MS })).resolves.toMatchObject({ failed: 0, deferred: 1 });
    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 90 * MINUTE_MS })).resolves.toMatchObject({ failed: 1, deferred: 0 });
    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 209 * MINUTE_MS })).resolves.toMatchObject({ failed: 0, deferred: 1 });
    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 210 * MINUTE_MS })).resolves.toMatchObject({ failed: 1, deferred: 0 });
    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 569 * MINUTE_MS })).resolves.toMatchObject({ deferred: 1 });
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(4);
  });

  it('creates only a first-failure event and a later recovery event', async () => {
    const site = await createSite();
    await createAccount(site.id);
    refreshAccountGroupRatesMock
      .mockResolvedValueOnce(failedOutcome('first failure'))
      .mockResolvedValueOnce(failedOutcome('second failure'))
      .mockResolvedValueOnce(syncedOutcome());

    await scheduler.executeAccountRateRefreshPass({ nowMs: 0 });
    await scheduler.executeAccountRateRefreshPass({ nowMs: 10 * MINUTE_MS });
    await scheduler.executeAccountRateRefreshPass({ nowMs: 30 * MINUTE_MS });
    await scheduler.executeAccountRateRefreshPass({ nowMs: 90 * MINUTE_MS });

    const events = await db.select().from(schema.events).orderBy(asc(schema.events.id)).all();
    expect(events.map((event) => event.title)).toEqual([
      '自动倍率刷新失败',
      '自动倍率刷新已恢复',
    ]);
  });

  it('counts an ordinary successful sync as recovered after a notified failure', async () => {
    const site = await createSite();
    await createAccount(site.id);
    refreshAccountGroupRatesMock
      .mockResolvedValueOnce(failedOutcome())
      .mockResolvedValueOnce(syncedOutcome());

    await scheduler.executeAccountRateRefreshPass({ nowMs: 0 });
    const recovery = await scheduler.executeAccountRateRefreshPass({ nowMs: 30 * MINUTE_MS });

    expect(recovery).toMatchObject({ synced: 1, recovered: 1 });
    expect(await db.select().from(schema.events).orderBy(asc(schema.events.id)).all())
      .toEqual([
        expect.objectContaining({ title: '自动倍率刷新失败' }),
        expect.objectContaining({ title: '自动倍率刷新已恢复' }),
      ]);
  });

  it('keeps a retryable failure notification when event persistence fails', async () => {
    const site = await createSite();
    await createAccount(site.id);
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    eventInsertFailures.remaining = 1;
    eventInsertFailures.message = 'Bearer database-secret';
    refreshAccountGroupRatesMock.mockResolvedValue(failedOutcome());

    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 0 })).resolves.toMatchObject({ failed: 1 });
    expect(await db.select().from(schema.events).all()).toEqual([]);
    expect(warningLog).toHaveBeenCalledWith('[account-rate-refresh] failed to persist failure event');
    expect(warningLog.mock.calls.flat().map(String).join('\n')).not.toContain('database-secret');

    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 30 * MINUTE_MS })).resolves.toMatchObject({ failed: 1 });
    expect(await db.select().from(schema.events).all())
      .toEqual([expect.objectContaining({ title: '自动倍率刷新失败' })]);
  });

  it('retries a missed recovery notification without restoring request backoff', async () => {
    const site = await createSite();
    await createAccount(site.id);
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    refreshAccountGroupRatesMock
      .mockResolvedValueOnce(failedOutcome())
      .mockResolvedValueOnce(syncedOutcome())
      .mockResolvedValueOnce(syncedOutcome());

    await scheduler.executeAccountRateRefreshPass({ nowMs: 0 });
    eventInsertFailures.remaining = 1;
    eventInsertFailures.message = 'sk-recovery-database-secret';

    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 30 * MINUTE_MS }))
      .resolves.toMatchObject({ synced: 1, recovered: 1, deferred: 0 });
    expect(warningLog).toHaveBeenCalledWith('[account-rate-refresh] failed to persist recovery event');
    expect(warningLog.mock.calls.flat().map(String).join('\n')).not.toContain('recovery-database-secret');

    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 31 * MINUTE_MS }))
      .resolves.toMatchObject({ synced: 1, recovered: 1, deferred: 0 });
    expect(await db.select().from(schema.events).orderBy(asc(schema.events.id)).all())
      .toEqual([
        expect.objectContaining({ title: '自动倍率刷新失败' }),
        expect.objectContaining({ title: '自动倍率刷新已恢复' }),
      ]);
  });

  it('never stores or logs raw upstream secrets in automatic failure summaries', async () => {
    const site = await createSite();
    await createAccount(site.id);
    const summaryLog = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    refreshAccountGroupRatesMock.mockResolvedValue(failedOutcome('Bearer secret-value sk-secret-value', 'upstream'));

    await scheduler.executeAccountRateRefreshPass({ nowMs: 0 });

    const events = await db.select().from(schema.events).all();
    const capturedText = [
      ...events.flatMap((event) => [event.title, event.message]),
      ...summaryLog.mock.calls.flatMap((args) => args.map(String)),
    ].join('\n');
    expect(capturedText).not.toContain('secret-value');
    expect(capturedText).not.toContain('sk-secret-value');
  });

  it('runs one immediate pass when an enabled scheduler starts', async () => {
    const site = await createSite();
    await createAccount(site.id);
    refreshAccountGroupRatesMock.mockResolvedValue(syncedOutcome());

    expect(scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 }))
      .toEqual({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
  });

  it('starts disabled from the hydrated config without running or scheduling a pass', async () => {
    const site = await createSite();
    await createAccount(site.id);
    refreshAccountGroupRatesMock.mockResolvedValue(syncedOutcome());
    config.accountGroupRateRefreshEnabled = false;
    config.accountGroupRateRefreshIntervalMinutes = 30;

    expect(scheduler.startAccountRateRefreshScheduler())
      .toEqual({ enabled: false, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(90 * MINUTE_MS);

    expect(refreshAccountGroupRatesMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts with the hydrated 45 minute interval', async () => {
    const site = await createSite();
    await createAccount(site.id);
    refreshAccountGroupRatesMock.mockResolvedValue(syncedOutcome());
    config.accountGroupRateRefreshEnabled = true;
    config.accountGroupRateRefreshIntervalMinutes = 45;

    expect(scheduler.startAccountRateRefreshScheduler())
      .toEqual({ enabled: true, intervalMinutes: 45 });
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(44 * MINUTE_MS);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(2);
  });

  it('does not overlap an in-flight immediate pass with an interval tick', async () => {
    const site = await createSite();
    await createAccount(site.id);
    let resolveRefresh: (() => void) | undefined;
    refreshAccountGroupRatesMock.mockImplementation(() => new Promise((resolve) => {
      resolveRefresh = () => resolve(syncedOutcome());
    }));

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);

    resolveRefresh?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('logs overlap when an interval tick finds a direct pass in flight', async () => {
    const site = await createSite();
    await createAccount(site.id);
    const summaryLog = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    refreshAccountGroupRatesMock.mockResolvedValue(syncedOutcome());

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    let resolveRefresh: (() => void) | undefined;
    refreshAccountGroupRatesMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = () => resolve(syncedOutcome());
    }));
    const directPass = scheduler.executeAccountRateRefreshPass({ nowMs: 0 });
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);

    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(2);
    expect(summaryLog).toHaveBeenCalledWith('[account-rate-refresh] skipped overlapping scheduled pass');
    resolveRefresh?.();
    await directPass;
  });

  it('reuses a contained direct pass from a scheduled tick without an unhandled rejection', async () => {
    const site = await createSite();
    await createAccount(site.id);
    const infoLog = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    refreshAccountGroupRatesMock.mockResolvedValue(syncedOutcome());

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    let rejectRefresh: ((reason?: unknown) => void) | undefined;
    refreshAccountGroupRatesMock.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectRefresh = reject;
    }));
    const directPass = scheduler.executeAccountRateRefreshPass({ nowMs: 0 });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
      rejectRefresh?.(new Error('Bearer direct-pass-secret'));
      await expect(directPass).resolves.toMatchObject({ failed: 1, synced: 0 });
      await vi.advanceTimersByTimeAsync(0);

      expect(unhandledRejections).toEqual([]);
      expect(infoLog).toHaveBeenCalledWith('[account-rate-refresh] skipped overlapping scheduled pass');
      expect(warningLog).not.toHaveBeenCalledWith('[account-rate-refresh] scheduled pass failed');
      expect([...infoLog.mock.calls, ...warningLog.mock.calls].flat().map(String).join('\n'))
        .not.toContain('direct-pass-secret');
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('reschedules interval changes without starting another immediate pass', async () => {
    const site = await createSite();
    await createAccount(site.id);
    refreshAccountGroupRatesMock.mockResolvedValue(syncedOutcome());

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 45 });
    await vi.advanceTimersByTimeAsync(44 * MINUTE_MS);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(2);
  });

  it('stops future interval ticks when disabled', async () => {
    const site = await createSite();
    await createAccount(site.id);
    refreshAccountGroupRatesMock.mockResolvedValue(syncedOutcome());

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    scheduler.updateAccountRateRefreshScheduler({ enabled: false, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(90 * MINUTE_MS);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
  });

  it('applies a concurrent re-enable after stop has drained its owned pass', async () => {
    const site = await createSite();
    await createAccount(site.id);
    let resolveRefresh: (() => void) | undefined;
    refreshAccountGroupRatesMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = () => resolve(syncedOutcome());
    })).mockResolvedValue(syncedOutcome());

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    const stopping = scheduler.stopAccountRateRefreshScheduler();
    expect(scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 45 }))
      .toEqual({ enabled: false, intervalMinutes: 45 });
    await vi.advanceTimersByTimeAsync(90 * MINUTE_MS);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    resolveRefresh?.();
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(44 * MINUTE_MS);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);
  });

  it('keeps a concurrent enable pending during an exclusive stop until start', async () => {
    const site = await createSite();
    await createAccount(site.id);
    let resolveRefresh: (() => void) | undefined;
    refreshAccountGroupRatesMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = () => resolve(syncedOutcome());
    })).mockResolvedValue(syncedOutcome());

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    const stopping = scheduler.stopAccountRateRefreshScheduler({ resumePendingUpdates: false });
    expect(scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 45 }))
      .toEqual({ enabled: false, intervalMinutes: 45 });

    resolveRefresh?.();
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    config.accountGroupRateRefreshEnabled = true;
    config.accountGroupRateRefreshIntervalMinutes = 45;
    expect(scheduler.startAccountRateRefreshScheduler())
      .toEqual({ enabled: true, intervalMinutes: 45 });
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('lets a final exclusive stop supersede a start requested during drain', async () => {
    const site = await createSite();
    await createAccount(site.id);
    let resolveRefresh: (() => void) | undefined;
    refreshAccountGroupRatesMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = () => resolve(syncedOutcome());
    })).mockResolvedValue(syncedOutcome());

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    const firstStop = scheduler.stopAccountRateRefreshScheduler({ resumePendingUpdates: false });
    scheduler.startAccountRateRefreshScheduler();
    const finalStop = scheduler.stopAccountRateRefreshScheduler({ resumePendingUpdates: false });

    resolveRefresh?.();
    await Promise.all([firstStop, finalStop]);
    await vi.advanceTimersByTimeAsync(90 * MINUTE_MS);

    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a final exclusive stop supersede an enabled update requested during drain', async () => {
    const site = await createSite();
    await createAccount(site.id);
    let resolveRefresh: (() => void) | undefined;
    refreshAccountGroupRatesMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = () => resolve(syncedOutcome());
    })).mockResolvedValue(syncedOutcome());

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    const firstStop = scheduler.stopAccountRateRefreshScheduler({ resumePendingUpdates: false });
    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 45 });
    const finalStop = scheduler.stopAccountRateRefreshScheduler({ resumePendingUpdates: false });

    resolveRefresh?.();
    await Promise.all([firstStop, finalStop]);
    await vi.advanceTimersByTimeAsync(90 * MINUTE_MS);

    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resumes only when start is newer than the final exclusive stop', async () => {
    const site = await createSite();
    await createAccount(site.id);
    let resolveRefresh: (() => void) | undefined;
    refreshAccountGroupRatesMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = () => resolve(syncedOutcome());
    })).mockResolvedValue(syncedOutcome());

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    const firstStop = scheduler.stopAccountRateRefreshScheduler({ resumePendingUpdates: false });
    const finalStop = scheduler.stopAccountRateRefreshScheduler({ resumePendingUpdates: false });
    scheduler.startAccountRateRefreshScheduler();

    resolveRefresh?.();
    await Promise.all([firstStop, finalStop]);
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('shares one drain across stop callers without preserving an older start', async () => {
    const site = await createSite();
    await createAccount(site.id);
    let resolveRefresh: (() => void) | undefined;
    refreshAccountGroupRatesMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = () => resolve(syncedOutcome());
    })).mockResolvedValue(syncedOutcome());

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    const firstStop = scheduler.stopAccountRateRefreshScheduler({ resumePendingUpdates: false });
    scheduler.startAccountRateRefreshScheduler();
    const secondStop = scheduler.stopAccountRateRefreshScheduler({ resumePendingUpdates: false });

    expect(secondStop).toBe(firstStop);
    resolveRefresh?.();
    await secondStop;
    await vi.advanceTimersByTimeAsync(90 * MINUTE_MS);

    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a hanging owned pass, drains it, and does not claim a later account', async () => {
    const site = await createSite();
    for (let index = 0; index < 4; index += 1) {
      await createAccount(site.id, { username: `abort-drain-${index}` });
    }
    const observedSignals: AbortSignal[] = [];
    const releaseFallbacks: Array<() => void> = [];
    refreshAccountGroupRatesMock.mockImplementation((_row, options) => new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal) {
        observedSignals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      } else {
        releaseFallbacks.push(() => resolve(syncedOutcome()));
      }
    }));

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);
    const stop = scheduler.stopAccountRateRefreshScheduler({ resumePendingUpdates: false });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(observedSignals).toHaveLength(3);
      expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      releaseFallbacks.forEach((release) => release());
      await stop;
    }

    await vi.advanceTimersByTimeAsync(90 * MINUTE_MS);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reset aborts its owned pass and leaves no timer or later account claim', async () => {
    const site = await createSite();
    for (let index = 0; index < 4; index += 1) {
      await createAccount(site.id, { username: `reset-abort-${index}` });
    }
    const observedSignals: AbortSignal[] = [];
    const releaseFallbacks: Array<() => void> = [];
    refreshAccountGroupRatesMock.mockImplementation((_row, options) => new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal) {
        observedSignals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      } else {
        releaseFallbacks.push(() => resolve(syncedOutcome()));
      }
    }));

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    const reset = scheduler.__resetAccountRateRefreshSchedulerForTests();

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(observedSignals).toHaveLength(3);
      expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      releaseFallbacks.forEach((release) => release());
      await reset;
    }

    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears one account backoff through the production reset function', async () => {
    const site = await createSite();
    const first = await createAccount(site.id, { username: 'restore-reset-first' });
    await createAccount(site.id, { username: 'restore-reset-second' });
    refreshAccountGroupRatesMock.mockResolvedValue(failedOutcome());

    await scheduler.executeAccountRateRefreshPass({ nowMs: 0 });
    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: MINUTE_MS }))
      .resolves.toMatchObject({ deferred: 2 });

    const clearFailureState = (scheduler as SchedulerModule & {
      clearAccountRateRefreshFailureState(accountId: number): void;
    }).clearAccountRateRefreshFailureState;
    clearFailureState(first.id);

    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 2 * MINUTE_MS }))
      .resolves.toMatchObject({ candidates: 2, deferred: 1, failed: 1 });
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);
  });

  it('stop waits for a direct in-flight pass and prevents queued accounts from starting', async () => {
    const site = await createSite();
    for (let index = 0; index < 5; index += 1) {
      await createAccount(site.id, { username: `stop-queued-${index}` });
    }
    const blockedResolvers: Array<() => void> = [];
    refreshAccountGroupRatesMock.mockImplementation(() => new Promise((resolve) => {
      blockedResolvers.push(() => resolve(syncedOutcome()));
    }));

    const pass = scheduler.executeAccountRateRefreshPass({ nowMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);
    let stopCompleted = false;
    const stop = scheduler.stopAccountRateRefreshScheduler().then(() => {
      stopCompleted = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopCompleted).toBe(false);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);

    blockedResolvers.forEach((resolve) => resolve());
    await vi.advanceTimersByTimeAsync(0);
    await stop;
    await pass;
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);
  });

  it('reset clears timers, in-flight state, and prior failure backoff', async () => {
    const site = await createSite();
    await createAccount(site.id);
    refreshAccountGroupRatesMock.mockResolvedValueOnce(failedOutcome()).mockResolvedValue(syncedOutcome());

    await scheduler.executeAccountRateRefreshPass({ nowMs: 0 });
    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.__resetAccountRateRefreshSchedulerForTests();

    expect(vi.getTimerCount()).toBe(0);
    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: MINUTE_MS })).resolves.toMatchObject({ deferred: 0, synced: 1 });
  });

  it('reset waits for the old worker and prevents it from claiming queued accounts', async () => {
    const site = await createSite();
    for (let index = 0; index < 5; index += 1) {
      await createAccount(site.id, { username: `reset-queued-${index}` });
    }
    const blockedResolvers: Array<() => void> = [];
    let blockedCalls = 0;
    refreshAccountGroupRatesMock.mockImplementation(() => {
      blockedCalls += 1;
      if (blockedCalls <= 3) {
        return new Promise((resolve) => {
          blockedResolvers.push(() => resolve(syncedOutcome()));
        });
      }
      return Promise.resolve(syncedOutcome());
    });

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);
    let resetCompleted = false;
    const reset = scheduler.__resetAccountRateRefreshSchedulerForTests().then(() => {
      resetCompleted = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resetCompleted).toBe(false);
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);

    blockedResolvers.forEach((resolve) => resolve());
    await vi.advanceTimersByTimeAsync(0);
    await reset;
    expect(refreshAccountGroupRatesMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not restore failure backoff when a pre-reset pass completes late', async () => {
    const site = await createSite();
    await createAccount(site.id);
    let resolveRefresh: (() => void) | undefined;
    refreshAccountGroupRatesMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = () => resolve(failedOutcome());
    })).mockResolvedValue(syncedOutcome());

    scheduler.updateAccountRateRefreshScheduler({ enabled: true, intervalMinutes: 30 });
    await vi.advanceTimersByTimeAsync(0);
    const reset = scheduler.__resetAccountRateRefreshSchedulerForTests();
    resolveRefresh?.();
    await vi.advanceTimersByTimeAsync(0);
    await reset;
    await scheduler.executeAccountRateRefreshPass({ nowMs: MINUTE_MS });

    await expect(scheduler.executeAccountRateRefreshPass({ nowMs: 2 * MINUTE_MS }))
      .resolves.toMatchObject({ deferred: 0, synced: 1 });
  });
});
