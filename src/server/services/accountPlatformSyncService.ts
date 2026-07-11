import { convergeAccountMutation } from './accountMutationWorkflow.js';
import { getCredentialModeFromExtraConfig, getProxyUrlFromExtraConfig, resolvePlatformUserId } from './accountExtraConfig.js';
import { recoverAccountSession, type ReloggedAccountSession } from './accountLoginSessionService.js';
import {
  refreshAccountGroupRates,
  type AccountRateSyncResult,
  type AccountWithSiteRow,
} from './accountRateSyncService.js';
import { getAdapter } from './platforms/index.js';
import { shouldAttemptAccountSessionRecovery } from './accountSessionRecoveryPolicy.js';
import { sessionSnapshotMatches } from './accountSessionPersistenceService.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import type { ApiTokenInfo, PlatformAdapter } from './platforms/base.js';

export type { AccountRateSyncResult, AccountWithSiteRow };

export type AccountPlatformSyncResult = {
  accountId: number;
  accountName: string;
  accountStatus: string | null;
  siteId: number;
  siteName: string;
  siteStatus: string | null;
  status: 'synced' | 'skipped' | 'failed';
  reason?: string;
  message?: string;
  synced: boolean;
  created: number;
  updated: number;
  maskedPending?: number;
  pendingTokenIds?: number[];
  total: number;
  defaultTokenId?: number | null;
  rateSync: AccountRateSyncResult;
};

const TOKEN_SYNC_TIMEOUT_MS = 15_000;
export const ACCOUNT_PLATFORM_SYNC_TIMEOUT_MS = 30_000;

function isSiteDisabled(status?: string | null): boolean {
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

function shouldRecoverTokenSyncFailure(error: unknown): boolean {
  const message = errorMessage(error, 'sync failed');
  const text = message.toLowerCase();
  if (
    text.includes('invalid api token list')
    || text.includes('invalid token list response')
    || text.includes('invalid api key list')
  ) {
    return false;
  }
  return shouldAttemptAccountSessionRecovery(message, 'broad');
}

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
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
      const timeoutError = new Error(timeoutMessage);
      controller.abort(timeoutError);
    }, timeoutMs);
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

function skippedRateSync(reason: string): AccountRateSyncResult {
  return { status: 'skipped', reason };
}

type UpstreamSyncContext = {
  accountId: number;
  expectedSession: typeof schema.accounts.$inferSelect;
  baseUrl: string;
  accessToken: string;
  platformUserId?: number;
  accountProxyUrl: string | null;
  adapter: PlatformAdapter;
};

type AccountTokenSyncOutcome = Pick<AccountPlatformSyncResult,
  | 'status'
  | 'reason'
  | 'message'
  | 'synced'
  | 'created'
  | 'updated'
  | 'maskedPending'
  | 'pendingTokenIds'
  | 'total'
  | 'defaultTokenId'
> & { recoveryEligible?: boolean };

async function syncAccountTokens(
  context: UpstreamSyncContext,
  ownerSignal: AbortSignal,
): Promise<AccountTokenSyncOutcome> {
  try {
    const timeoutMessage = `token sync timeout (${Math.round(TOKEN_SYNC_TIMEOUT_MS / 1000)}s)`;
    let tokens = await withTimeout(
      (signal) => withAccountProxyOverride(context.accountProxyUrl,
        () => context.adapter.getApiTokens(
          context.baseUrl,
          context.accessToken,
          context.platformUserId,
          signal,
        )),
      TOKEN_SYNC_TIMEOUT_MS,
      timeoutMessage,
      ownerSignal,
    );
    if (!Array.isArray(tokens)) {
      throw new Error('upstream returned an invalid api token list');
    }

    if (tokens.length === 0) {
      const fallback = await withTimeout(
        (signal) => withAccountProxyOverride(context.accountProxyUrl,
          () => context.adapter.getApiToken(
            context.baseUrl,
            context.accessToken,
            context.platformUserId,
            signal,
          )),
        TOKEN_SYNC_TIMEOUT_MS,
        timeoutMessage,
        ownerSignal,
      );
      if (fallback) {
        tokens = [{ name: 'default', key: fallback, enabled: true, tokenGroup: 'default' }];
      }
    }

    if (tokens.length === 0) {
      return {
        status: 'skipped',
        reason: 'no_upstream_tokens',
        message: 'upstream returned no api tokens',
        synced: false,
        created: 0,
        updated: 0,
        total: 0,
        defaultTokenId: null,
      };
    }

    const convergence = await convergeAccountMutation({
      accountId: context.accountId,
      upstreamTokens: tokens as ApiTokenInfo[],
      expectedSession: context.expectedSession,
    });
    if (convergence.stale) {
      return {
        status: 'skipped',
        reason: 'account_session_changed',
        message: 'account session changed during token synchronization',
        synced: false,
        created: 0,
        updated: 0,
        total: 0,
        defaultTokenId: null,
      };
    }
    if (!convergence.tokenSync) {
      throw new Error('token sync did not persist any result');
    }

    const tokenSync = convergence.tokenSync;
    if ((tokenSync.maskedPending || 0) > 0) {
      return {
        status: 'synced',
        reason: 'upstream_masked_tokens',
        message: `上游返回 ${tokenSync.maskedPending} 条脱敏令牌，已保存为待补全记录，请手动补全明文 token。`,
        synced: true,
        ...tokenSync,
      };
    }

    return {
      status: 'synced',
      synced: true,
      ...tokenSync,
    };
  } catch (error) {
    return {
      status: 'failed',
      reason: 'sync_error',
      message: errorMessage(error, 'sync failed'),
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
      recoveryEligible: shouldRecoverTokenSyncFailure(error),
    };
  }
}

function applyRecoveredSession(
  row: AccountWithSiteRow,
  recovered: ReloggedAccountSession,
): AccountWithSiteRow {
  const status = (row.accounts.status || 'active') === 'expired'
    ? 'active'
    : row.accounts.status;
  return {
    ...row,
    accounts: {
      ...row.accounts,
      accessToken: recovered.accessToken,
      extraConfig: recovered.extraConfig,
      status,
    },
  };
}

function createUpstreamSyncContext(
  row: AccountWithSiteRow,
  adapter: PlatformAdapter,
): UpstreamSyncContext {
  return {
    accountId: row.accounts.id,
    expectedSession: row.accounts,
    baseUrl: row.sites.url,
    accessToken: String(row.accounts.accessToken || '').trim(),
    platformUserId: resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username),
    accountProxyUrl: getProxyUrlFromExtraConfig(row.accounts.extraConfig),
    adapter,
  };
}

async function loadCurrentAccountWithSite(accountId: number): Promise<AccountWithSiteRow | null> {
  return await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get() ?? null;
}

/**
 * 同步账号的上游令牌及分组倍率。令牌是主流程；倍率失败只返回部分失败状态并保留旧快照。
 */
async function syncAccountPlatformDataWithSignal(
  row: AccountWithSiteRow,
  ownerSignal: AbortSignal,
): Promise<AccountPlatformSyncResult> {
  const accountId = row.accounts.id;
  const base = {
    accountId,
    accountName: row.accounts.username || `account-${accountId}`,
    accountStatus: row.accounts.status,
    siteId: row.sites.id,
    siteName: row.sites.name,
    siteStatus: row.sites.status,
  };

  if (isSiteDisabled(row.sites.status)) {
    return {
      ...base,
      status: 'skipped',
      reason: 'site_disabled',
      message: 'site disabled',
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
      rateSync: skippedRateSync('site_disabled'),
    };
  }

  if (isApiKeyConnection(row.accounts)) {
    return {
      ...base,
      status: 'skipped',
      reason: 'apikey_connection',
      message: 'apikey connection does not support account tokens',
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
      rateSync: skippedRateSync('apikey_connection'),
    };
  }

  const accessToken = (row.accounts.accessToken || '').trim();
  if (!accessToken) {
    if (row.accounts.apiToken) {
      try {
        const convergence = await convergeAccountMutation({
          accountId,
          preferredApiToken: row.accounts.apiToken,
          defaultTokenSource: 'legacy',
        });
        if (convergence.defaultTokenId != null) {
          return {
            ...base,
            status: 'synced',
            reason: 'legacy_default_token_restored',
            message: 'restored local default token from legacy api token',
            synced: true,
            created: 0,
            updated: 0,
            total: 0,
            defaultTokenId: convergence.defaultTokenId,
            rateSync: skippedRateSync('missing_access_token'),
          };
        }
      } catch (error) {
        return {
          ...base,
          status: 'failed',
          reason: 'sync_error',
          message: errorMessage(error, 'sync failed'),
          synced: false,
          created: 0,
          updated: 0,
          total: 0,
          defaultTokenId: null,
          rateSync: skippedRateSync('token_sync_failed'),
        };
      }
    }

    return {
      ...base,
      status: 'skipped',
      reason: 'missing_access_token',
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
      rateSync: skippedRateSync('missing_access_token'),
    };
  }

  const adapter = getAdapter(row.sites.platform);
  if (!adapter) {
    return {
      ...base,
      status: 'failed',
      reason: 'unsupported_platform',
      message: `不支持的平台: ${row.sites.platform}`,
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
      rateSync: skippedRateSync('unsupported_platform'),
    };
  }

  let activeRow = row;
  let tokenAttempt = await syncAccountTokens(createUpstreamSyncContext(activeRow, adapter), ownerSignal);
  if (tokenAttempt.reason === 'account_session_changed') {
    const winner = await loadCurrentAccountWithSite(accountId);
    if (!winner) {
      const { recoveryEligible: _recoveryEligible, ...tokenSync } = tokenAttempt;
      return { ...base, ...tokenSync, rateSync: skippedRateSync('account_deleted') };
    }
    activeRow = winner;
  }
  const sessionRecoveryAttempted = tokenAttempt.recoveryEligible === true;
  if (sessionRecoveryAttempted) {
    let recovered: ReloggedAccountSession | null = null;
    try {
      recovered = await recoverAccountSession(row.accounts, row.sites, { signal: ownerSignal });
    } catch (error) {
      if (ownerSignal.aborted) {
        tokenAttempt = {
          status: 'failed',
          reason: 'sync_error',
          message: errorMessage(ownerSignal.reason ?? error, 'sync failed'),
          synced: false,
          created: 0,
          updated: 0,
          total: 0,
          defaultTokenId: null,
        };
      }
    }
    if (recovered) {
      activeRow = applyRecoveredSession(row, recovered);
      tokenAttempt = await syncAccountTokens(createUpstreamSyncContext(activeRow, adapter), ownerSignal);
    } else {
      const winner = await loadCurrentAccountWithSite(accountId);
      if (!winner) {
        const { recoveryEligible: _recoveryEligible, ...tokenSync } = tokenAttempt;
        return { ...base, ...tokenSync, rateSync: skippedRateSync('account_deleted') };
      }
      activeRow = winner;
      if (
        (winner.accounts.status || 'active') !== 'disabled'
        && !isSiteDisabled(winner.sites.status)
        && !sessionSnapshotMatches(winner.accounts, row.accounts)
      ) {
        tokenAttempt = await syncAccountTokens(createUpstreamSyncContext(activeRow, adapter), ownerSignal);
      }
    }
  }

  const { recoveryEligible: _recoveryEligible, ...tokenSync } = tokenAttempt;
  const rateOutcome = sessionRecoveryAttempted
    ? await refreshAccountGroupRates(activeRow, { sessionRecoveryAttempted: true, signal: ownerSignal })
    : await refreshAccountGroupRates(activeRow, { signal: ownerSignal });
  const rateSync = rateOutcome.rateSync;

  return {
    ...base,
    ...tokenSync,
    rateSync,
  };
}

export async function syncAccountPlatformData(row: AccountWithSiteRow): Promise<AccountPlatformSyncResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(
      `account platform sync timeout (${Math.round(ACCOUNT_PLATFORM_SYNC_TIMEOUT_MS / 1000)}s)`,
    ));
  }, ACCOUNT_PLATFORM_SYNC_TIMEOUT_MS);
  try {
    return await syncAccountPlatformDataWithSignal(row, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
