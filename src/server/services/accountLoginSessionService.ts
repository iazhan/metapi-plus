import { schema } from '../db/index.js';
import {
  abortAndClearSingleflights,
  type AbortableSingleflightGeneration,
  awaitWithAbortSignal,
  runAbortableSingleflight,
} from './abortableSingleflight.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import {
  getAutoReloginConfig,
  getSub2ApiAuthFromExtraConfig,
  mergeAccountExtraConfig,
  resolvePlatformUserId,
  resolveProxyUrlFromExtraConfig,
} from './accountExtraConfig.js';
import { getAdapter } from './platforms/index.js';
import type { LoginResult } from './platforms/base.js';
import { persistRecoveredAccountSession } from './accountSessionPersistenceService.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { isSub2ApiPlatform } from './sub2apiManagedAuth.js';
import { refreshSub2ApiManagedSessionSingleflight } from './sub2apiRefreshSingleflight.js';

export type ReloggedAccountSession = {
  accessToken: string;
  extraConfig: string | null;
  platformUserId?: number;
};

const reloginInFlight = new Map<
  number,
  AbortableSingleflightGeneration<ReloggedAccountSession | null>
>();

export function mergeLoginSessionMetadata(
  extraConfig: string | Record<string, unknown> | null | undefined,
  platform: string | null | undefined,
  loginResult: LoginResult,
): string {
  const patch: Record<string, unknown> = {};
  if (loginResult.platformUserId) {
    patch.platformUserId = loginResult.platformUserId;
  }
  if ((platform || '').trim().toLowerCase() === 'sub2api' && loginResult.refreshToken) {
    patch.sub2apiAuth = {
      refreshToken: loginResult.refreshToken,
      ...(loginResult.expiresAt ? { tokenExpiresAt: loginResult.expiresAt } : {}),
    };
  }
  return mergeAccountExtraConfig(extraConfig, patch);
}

async function performAccountRelogin(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
  signal?: AbortSignal,
): Promise<ReloggedAccountSession | null> {
  const adapter = getAdapter(site.platform);
  if (!adapter) return null;

  const relogin = getAutoReloginConfig(account.extraConfig);
  if (!relogin) return null;
  const password = decryptAccountPassword(relogin.passwordCipher);
  if (!password) return null;

  const loginResult = await withAccountProxyOverride(
    resolveProxyUrlFromExtraConfig(account.extraConfig),
    () => adapter.login(site.url, relogin.username, password, signal),
  );
  signal?.throwIfAborted();
  if (!loginResult.success || !loginResult.accessToken) return null;

  const persisted = await persistRecoveredAccountSession({
    account,
    accessToken: loginResult.accessToken,
    signal,
    mergeExtraConfig: (latestExtraConfig) => mergeLoginSessionMetadata(
      latestExtraConfig,
      site.platform,
      loginResult,
    ),
  });
  if (!persisted) return null;

  const extraConfig = persisted.extraConfig;
  const platformUserId = loginResult.platformUserId
    ?? resolvePlatformUserId(extraConfig, persisted.account.username);

  return {
    accessToken: loginResult.accessToken,
    extraConfig,
    ...(platformUserId ? { platformUserId } : {}),
  };
}

/**
 * Refreshes one account session and coalesces concurrent balance/check-in retries.
 */
export function reloginAccountSession(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
  options: { signal?: AbortSignal } = {},
): Promise<ReloggedAccountSession | null> {
  return runAbortableSingleflight(
    reloginInFlight,
    account.id,
    (operationSignal) => performAccountRelogin(account, site, operationSignal),
    options.signal,
  );
}

/**
 * Recovers one account session through the platform-managed refresh path first,
 * then falls back to the encrypted account-password relogin singleflight.
 */
export async function recoverAccountSession(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
  options: { signal?: AbortSignal } = {},
): Promise<ReloggedAccountSession | null> {
  if (
    isSub2ApiPlatform(site.platform)
    && getSub2ApiAuthFromExtraConfig(account.extraConfig)?.refreshToken
  ) {
    try {
      const refreshed = await awaitWithAbortSignal(refreshSub2ApiManagedSessionSingleflight({
        account,
        site,
        currentAccessToken: String(account.accessToken || '').trim(),
        currentExtraConfig: account.extraConfig,
        signal: options.signal,
      }), options.signal);
      const accessToken = String(refreshed.accessToken || '').trim();
      if (accessToken) {
        const platformUserId = resolvePlatformUserId(refreshed.extraConfig, account.username);
        return {
          accessToken,
          extraConfig: refreshed.extraConfig,
          ...(platformUserId ? { platformUserId } : {}),
        };
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // Password relogin is the final recovery path when managed refresh cannot complete.
    }
  }

  return reloginAccountSession(account, site, options);
}

export function __resetAccountReloginSingleflightForTests(): void {
  abortAndClearSingleflights(reloginInFlight);
}
