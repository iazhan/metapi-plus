import { and, eq, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getSub2ApiAuthFromExtraConfig } from './accountExtraConfig.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import {
  isManagedSub2ApiTokenDue,
  isSub2ApiPlatform,
} from './sub2apiManagedAuth.js';
import { refreshSub2ApiManagedSessionSingleflight } from './sub2apiRefreshSingleflight.js';

const ACTIVE_STATUS = 'active';
const EXPIRED_STATUS = 'expired';
const SUB2API_PLATFORM = 'sub2api';
const SUB2API_REFRESH_SCHEDULER_INTERVAL_MS = 60_000;
const SUB2API_REFRESH_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
] as const;
export const SUB2API_REFRESH_SCHEDULER_CONCURRENCY = 4;

let sub2ApiRefreshSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let sub2ApiRefreshPassInFlight: Promise<void> | null = null;
const sub2ApiRefreshFailures = new Map<number, {
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt?: number;
  failureCount: number;
  retryAtMs: number;
}>();

function clearSub2ApiRefreshSchedulerTimer(): void {
  if (!sub2ApiRefreshSchedulerTimer) return;
  clearInterval(sub2ApiRefreshSchedulerTimer);
  sub2ApiRefreshSchedulerTimer = null;
}

function normalizeLifecycleStatus(value?: string | null): string {
  if (typeof value !== 'string') return ACTIVE_STATUS;
  const normalized = value.trim().toLowerCase();
  return normalized || ACTIVE_STATUS;
}

function normalizedLifecycleStatusSql(column: typeof schema.accounts.status | typeof schema.sites.status) {
  return sql<string>`coalesce(nullif(lower(trim(${column})), ''), ${ACTIVE_STATUS})`;
}

function normalizedPlatformSql(column: typeof schema.sites.platform) {
  return sql<string>`coalesce(lower(trim(${column})), '')`;
}

function shouldRefreshManagedSub2ApiAccount(input: {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  nowMs: number;
}): boolean {
  if (!isSub2ApiPlatform(input.site.platform)) return false;
  if (normalizeLifecycleStatus(input.site.status) !== ACTIVE_STATUS) return false;

  const accountStatus = normalizeLifecycleStatus(input.account.status);
  if (accountStatus !== ACTIVE_STATUS && accountStatus !== EXPIRED_STATUS) return false;

  const managedAuth = getSub2ApiAuthFromExtraConfig(input.account.extraConfig);
  if (!managedAuth?.refreshToken) return false;
  if (accountStatus === EXPIRED_STATUS) return true;
  if (!managedAuth.tokenExpiresAt) return false;

  return isManagedSub2ApiTokenDue(managedAuth.tokenExpiresAt, input.nowMs);
}

function getMatchingRefreshFailure(
  account: typeof schema.accounts.$inferSelect,
) {
  const failure = sub2ApiRefreshFailures.get(account.id);
  if (!failure) return null;

  const managedAuth = getSub2ApiAuthFromExtraConfig(account.extraConfig);
  const matchesSession = failure.accessToken === String(account.accessToken || '')
    && failure.refreshToken === (managedAuth?.refreshToken || '')
    && failure.tokenExpiresAt === managedAuth?.tokenExpiresAt;
  if (matchesSession) return failure;

  sub2ApiRefreshFailures.delete(account.id);
  return null;
}

function isRefreshDeferred(
  account: typeof schema.accounts.$inferSelect,
  nowMs: number,
): boolean {
  const failure = getMatchingRefreshFailure(account);
  return !!failure && nowMs < failure.retryAtMs;
}

function recordRefreshFailure(
  account: typeof schema.accounts.$inferSelect,
  nowMs: number,
): void {
  const previous = getMatchingRefreshFailure(account);
  const failureCount = (previous?.failureCount || 0) + 1;
  const delayIndex = Math.min(failureCount - 1, SUB2API_REFRESH_RETRY_DELAYS_MS.length - 1);
  const managedAuth = getSub2ApiAuthFromExtraConfig(account.extraConfig);
  sub2ApiRefreshFailures.set(account.id, {
    accessToken: String(account.accessToken || ''),
    refreshToken: managedAuth?.refreshToken || '',
    tokenExpiresAt: managedAuth?.tokenExpiresAt,
    failureCount,
    retryAtMs: nowMs + SUB2API_REFRESH_RETRY_DELAYS_MS[delayIndex],
  });
}

export async function executeSub2ApiManagedRefreshPass(input: {
  nowMs?: number;
} = {}) {
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs)
    ? input.nowMs
    : Date.now();
  const rows = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      or(
        sql`${normalizedLifecycleStatusSql(schema.accounts.status)} = ${ACTIVE_STATUS}`,
        sql`${normalizedLifecycleStatusSql(schema.accounts.status)} = ${EXPIRED_STATUS}`,
      ),
      sql`${normalizedLifecycleStatusSql(schema.sites.status)} = ${ACTIVE_STATUS}`,
      sql`${normalizedPlatformSql(schema.sites.platform)} = ${SUB2API_PLATFORM}`,
    ))
    .all();

  const refreshCandidates = rows.filter((row) => (
    shouldRefreshManagedSub2ApiAccount({
      account: row.accounts,
      site: row.sites,
      nowMs,
    }) && !isRefreshDeferred(row.accounts, nowMs)
  ));
  const refreshedAccountIds: number[] = [];
  const failedAccountIds: number[] = [];
  const skipped = rows.length - refreshCandidates.length;

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(SUB2API_REFRESH_SCHEDULER_CONCURRENCY, refreshCandidates.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const row = refreshCandidates[cursor];
      cursor += 1;
      if (!row) return;

      try {
        const refreshed = await refreshSub2ApiManagedSessionSingleflight({
          account: row.accounts,
          site: row.sites,
          currentAccessToken: row.accounts.accessToken || '',
          currentExtraConfig: row.accounts.extraConfig,
        });
        sub2ApiRefreshFailures.delete(row.accounts.id);
        await setAccountRuntimeHealth(row.accounts.id, {
          state: 'healthy',
          reason: 'Sub2API 托管会话刷新成功',
          source: 'sub2api-refresh',
        }, {
          expectedSession: {
            accessToken: refreshed.accessToken,
            extraConfig: refreshed.extraConfig,
          },
        });
        refreshedAccountIds.push(row.accounts.id);
      } catch (error) {
        const message = (error as Error)?.message || 'unknown error';
        recordRefreshFailure(row.accounts, nowMs);
        await setAccountRuntimeHealth(row.accounts.id, {
          state: 'unhealthy',
          reason: message,
          source: 'sub2api-refresh',
        }, {
          expectedSession: {
            accessToken: row.accounts.accessToken || '',
            extraConfig: row.accounts.extraConfig ?? null,
          },
        });
        failedAccountIds.push(row.accounts.id);
        console.warn(
          `[sub2api-refresh] failed to refresh account ${row.accounts.id}: ${message}`,
        );
      }
    }
  }));

  return {
    scanned: rows.length,
    refreshed: refreshedAccountIds.length,
    failed: failedAccountIds.length,
    skipped,
    refreshedAccountIds,
    failedAccountIds,
  };
}

async function runScheduledSub2ApiRefreshPass(): Promise<void> {
  if (sub2ApiRefreshPassInFlight) {
    return sub2ApiRefreshPassInFlight;
  }

  sub2ApiRefreshPassInFlight = executeSub2ApiManagedRefreshPass()
    .then(() => undefined)
    .catch((error) => {
      console.warn(`[sub2api-refresh] scheduled pass failed: ${(error as Error)?.message || 'unknown error'}`);
    })
    .finally(() => {
      sub2ApiRefreshPassInFlight = null;
    });

  return sub2ApiRefreshPassInFlight;
}

export function startSub2ApiManagedRefreshScheduler(intervalMs = SUB2API_REFRESH_SCHEDULER_INTERVAL_MS) {
  clearSub2ApiRefreshSchedulerTimer();

  const safeIntervalMs = Math.max(SUB2API_REFRESH_SCHEDULER_INTERVAL_MS, Math.trunc(intervalMs || 0));
  void runScheduledSub2ApiRefreshPass();
  sub2ApiRefreshSchedulerTimer = setInterval(() => {
    void runScheduledSub2ApiRefreshPass();
  }, safeIntervalMs);
  sub2ApiRefreshSchedulerTimer.unref?.();

  return {
    enabled: true,
    intervalMs: safeIntervalMs,
  };
}

export async function stopSub2ApiManagedRefreshScheduler() {
  clearSub2ApiRefreshSchedulerTimer();
  if (sub2ApiRefreshPassInFlight) {
    await sub2ApiRefreshPassInFlight;
  }
}

export async function __resetSub2ApiManagedRefreshSchedulerForTests() {
  await stopSub2ApiManagedRefreshScheduler();
  sub2ApiRefreshPassInFlight = null;
  sub2ApiRefreshFailures.clear();
}
