import { db, schema } from '../db/index.js';
import {
  getCredentialModeFromExtraConfig,
  getProxyUrlFromExtraConfig,
  getSub2ApiAuthFromExtraConfig,
  resolvePlatformUserId,
} from './accountExtraConfig.js';
import { normalizeGroupRate, replaceAccountGroupRatesForSession } from './accountGroupRateService.js';
import { reloginAccountSession } from './accountLoginSessionService.js';
import { shouldAttemptAccountSessionRecovery } from './accountSessionRecoveryPolicy.js';
import { getAdapter } from './platforms/index.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { isSub2ApiPlatform } from './sub2apiManagedAuth.js';
import { refreshSub2ApiManagedSessionSingleflight } from './sub2apiRefreshSingleflight.js';
import { expireAccountSessionIfCurrent } from './accountSessionPersistenceService.js';
import type { GroupRateInfo } from './platforms/base.js';

export const ACCOUNT_RATE_SYNC_TIMEOUT_MS = 15_000;

export type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

export type AccountRateSyncResult =
  | { status: 'synced'; total: number; syncedAt: string }
  | { status: 'unsupported' }
  | { status: 'failed'; message: string }
  | { status: 'skipped'; reason: string };

export type AccountRateRefreshFailureKind =
  | 'auth'
  | 'timeout'
  | 'invalid_response'
  | 'upstream'
  | 'storage';

export type AccountRateRefreshOutcome = {
  rateSync: AccountRateSyncResult;
  recoveredSession: boolean;
  failureKind?: AccountRateRefreshFailureKind;
};

export type AccountRateRefreshOptions = {
  sessionRecoveryAttempted?: boolean;
  signal?: AbortSignal;
};

class InvalidRateResponseError extends Error {}
class RateSyncTimeoutError extends Error {}
class RateSyncStorageError extends Error {}

function isDisabledStatus(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function isApiKeyConnection(account: typeof schema.accounts.$inferSelect): boolean {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit && explicit !== 'auto') return explicit === 'apikey';
  return !(account.accessToken || '').trim();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : fallback;
}

function classifyRateFailure(error: unknown): AccountRateRefreshFailureKind {
  if (error instanceof RateSyncStorageError) return 'storage';
  if (error instanceof InvalidRateResponseError) return 'invalid_response';
  if (error instanceof RateSyncTimeoutError) return 'timeout';

  const message = errorMessage(error, 'rate sync failed');
  const text = message.toLowerCase();
  if (/\b(?:timeout|timed out)\b/.test(text)) return 'timeout';
  if (shouldAttemptAccountSessionRecovery(message, 'broad')) return 'auth';
  if (
    /<(?:!doctype|html|head|body|title)\b/i.test(message)
    || text.includes('invalid group rate')
    || text.includes('invalid rate response')
  ) {
    return 'invalid_response';
  }
  return 'upstream';
}

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ownerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = ownerSignal
    ? AbortSignal.any([ownerSignal, controller.signal])
    : controller.signal;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => settle(() => reject(
      signal.reason ?? new DOMException('The operation was aborted', 'AbortError'),
    ));
    const timer = setTimeout(() => {
      const timeoutError = new RateSyncTimeoutError(
        `rate sync timeout (${Math.round(ACCOUNT_RATE_SYNC_TIMEOUT_MS / 1000)}s)`,
      );
      controller.abort(timeoutError);
    }, ACCOUNT_RATE_SYNC_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    Promise.resolve()
      .then(() => fn(signal))
      .then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
  });
}

async function requestGroupRates(input: {
  row: AccountWithSiteRow;
  accessToken: string;
  platformUserId?: number;
  signal?: AbortSignal;
}): Promise<GroupRateInfo[]> {
  const adapter = getAdapter(input.row.sites.platform);
  if (!adapter?.getGroupRates) {
    throw new InvalidRateResponseError('group rate endpoint is unavailable');
  }

  const rates = await withTimeout((signal) => withAccountProxyOverride(
    getProxyUrlFromExtraConfig(input.row.accounts.extraConfig),
    () => adapter.getGroupRates!(
      input.row.sites.url,
      input.accessToken,
      input.platformUserId,
      signal,
    ),
  ), input.signal);
  if (!Array.isArray(rates)) {
    throw new InvalidRateResponseError('upstream returned an invalid rate response');
  }

  try {
    return rates.map((rate, index) => normalizeGroupRate(rate, index));
  } catch (error) {
    throw new InvalidRateResponseError(errorMessage(error, 'upstream returned an invalid rate response'));
  }
}

async function recoverRateSession(
  row: AccountWithSiteRow,
  signal?: AbortSignal,
): Promise<{ accessToken: string; extraConfig: string | null; platformUserId?: number } | null> {
  if (
    isSub2ApiPlatform(row.sites.platform)
    && getSub2ApiAuthFromExtraConfig(row.accounts.extraConfig)?.refreshToken
  ) {
    try {
      const refreshed = await refreshSub2ApiManagedSessionSingleflight({
        account: row.accounts,
        site: row.sites,
        currentAccessToken: String(row.accounts.accessToken || '').trim(),
        currentExtraConfig: row.accounts.extraConfig,
        signal,
      });
      const accessToken = String(refreshed.accessToken || '').trim();
      if (accessToken) {
        const platformUserId = resolvePlatformUserId(refreshed.extraConfig, row.accounts.username);
        return platformUserId
          ? { accessToken, extraConfig: refreshed.extraConfig, platformUserId }
          : { accessToken, extraConfig: refreshed.extraConfig };
      }
    } catch {
      signal?.throwIfAborted();
      // Fall through to encrypted-credential relogin.
    }
  }

  const relogged = await reloginAccountSession(row.accounts, row.sites, { signal });
  const accessToken = String(relogged?.accessToken || '').trim();
  if (!relogged || !accessToken) return null;
  return relogged.platformUserId
    ? { accessToken, extraConfig: relogged.extraConfig, platformUserId: relogged.platformUserId }
    : { accessToken, extraConfig: relogged.extraConfig };
}

async function persistGroupRates(
  accountId: number,
  expectedAccessToken: string,
  expectedExtraConfig: string | null,
  rates: GroupRateInfo[],
  syncedAt: string,
): Promise<{ status: 'persisted'; total: number } | { status: 'stale' }> {
  try {
    return await replaceAccountGroupRatesForSession(
      accountId,
      expectedAccessToken,
      expectedExtraConfig,
      rates,
      syncedAt,
    );
  } catch (error) {
    if (error instanceof InvalidRateResponseError) throw error;
    throw new RateSyncStorageError(errorMessage(error, 'rate snapshot storage failed'));
  }
}

/**
 * Refreshes only one account's complete group-rate snapshot and preserves stale data on failure.
 */
export async function refreshAccountGroupRates(
  row: AccountWithSiteRow,
  options: AccountRateRefreshOptions = {},
): Promise<AccountRateRefreshOutcome> {
  if (isDisabledStatus(row.sites.status)) {
    return { rateSync: { status: 'skipped', reason: 'site_disabled' }, recoveredSession: false };
  }
  if (isDisabledStatus(row.accounts.status)) {
    return { rateSync: { status: 'skipped', reason: 'account_disabled' }, recoveredSession: false };
  }
  if (isApiKeyConnection(row.accounts)) {
    return { rateSync: { status: 'skipped', reason: 'apikey_connection' }, recoveredSession: false };
  }

  const adapter = getAdapter(row.sites.platform);
  if (!adapter?.getGroupRates) {
    return { rateSync: { status: 'unsupported' }, recoveredSession: false };
  }

  let accessToken = String(row.accounts.accessToken || '').trim();
  let activeExtraConfig = row.accounts.extraConfig ?? null;
  let platformUserId = resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username);
  let recoveredSession = false;
  let recoveryAttempted = options.sessionRecoveryAttempted === true;

  if ((row.accounts.status || 'active') === 'expired' && !recoveryAttempted) {
    recoveryAttempted = true;
    let recovered: Awaited<ReturnType<typeof recoverRateSession>> = null;
    try {
      recovered = await recoverRateSession(row, options.signal);
    } catch (error) {
      return {
        rateSync: { status: 'failed', message: errorMessage(error, 'rate sync failed') },
        recoveredSession,
        failureKind: classifyRateFailure(error),
      };
    }
    if (recovered) {
      accessToken = recovered.accessToken;
      activeExtraConfig = recovered.extraConfig;
      platformUserId = recovered.platformUserId ?? platformUserId;
      recoveredSession = true;
    }
  }

  if (!accessToken) {
    return { rateSync: { status: 'skipped', reason: 'missing_access_token' }, recoveredSession };
  }

  try {
    const rates = await requestGroupRates({ row, accessToken, platformUserId, signal: options.signal });
    const syncedAt = new Date().toISOString();
    const persisted = await persistGroupRates(row.accounts.id, accessToken, activeExtraConfig, rates, syncedAt);
    if (persisted.status === 'stale') {
      return {
        rateSync: { status: 'skipped', reason: 'account_session_changed' },
        recoveredSession,
      };
    }
    return {
      rateSync: { status: 'synced', total: persisted.total, syncedAt },
      recoveredSession,
    };
  } catch (firstError) {
    const firstMessage = errorMessage(firstError, 'rate sync failed');
    const firstFailureKind = classifyRateFailure(firstError);
    if (firstFailureKind !== 'auth') {
      return {
        rateSync: { status: 'failed', message: firstMessage },
        recoveredSession,
        failureKind: firstFailureKind,
      };
    }

    let recovered: Awaited<ReturnType<typeof recoverRateSession>> = null;
    if (!recoveryAttempted) {
      try {
        recovered = await recoverRateSession(row, options.signal);
      } catch (error) {
        return {
          rateSync: { status: 'failed', message: errorMessage(error, firstMessage) },
          recoveredSession,
          failureKind: classifyRateFailure(error),
        };
      }
    }
    if (!recovered) {
      await expireAccountSessionIfCurrent({
        accountId: row.accounts.id,
        accessToken,
        extraConfig: activeExtraConfig,
      });
      return {
        rateSync: { status: 'failed', message: firstMessage },
        recoveredSession,
        failureKind: 'auth',
      };
    }

    try {
      const rates = await requestGroupRates({
        row,
        accessToken: recovered.accessToken,
        platformUserId: recovered.platformUserId ?? platformUserId,
        signal: options.signal,
      });
      const syncedAt = new Date().toISOString();
      const persisted = await persistGroupRates(
        row.accounts.id,
        recovered.accessToken,
        recovered.extraConfig,
        rates,
        syncedAt,
      );
      if (persisted.status === 'stale') {
        return {
          rateSync: { status: 'skipped', reason: 'account_session_changed' },
          recoveredSession: true,
        };
      }
      return {
        rateSync: { status: 'synced', total: persisted.total, syncedAt },
        recoveredSession: true,
      };
    } catch (retryError) {
      const retryMessage = errorMessage(retryError, 'rate sync failed');
      const retryFailureKind = classifyRateFailure(retryError);
      if (retryFailureKind === 'auth') {
        await expireAccountSessionIfCurrent({
          accountId: row.accounts.id,
          accessToken: recovered.accessToken,
          extraConfig: recovered.extraConfig,
        });
      }
      return {
        rateSync: { status: 'failed', message: retryMessage },
        recoveredSession: true,
        failureKind: retryFailureKind,
      };
    }
  }
}
