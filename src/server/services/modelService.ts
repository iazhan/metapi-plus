import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getInsertedRowId } from '../db/insertHelpers.js';
import { getAdapter } from './platforms/index.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  ensureDefaultTokenForAccount,
  getPreferredAccountToken,
  isMaskedTokenValue,
  isUsableAccountToken,
} from './accountTokenService.js';
import {
  getCredentialModeFromExtraConfig,
  resolveProxyUrlFromExtraConfig,
  requiresManagedAccountTokens,
  resolvePlatformUserId,
  supportsDirectAccountRoutingConnection,
} from './accountExtraConfig.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';
import { getBlockedBrandRules, isModelBlockedByBrand } from './brandMatcher.js';
import { config } from '../config.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { clearAllRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { requireSiteApiBaseUrl } from './siteApiEndpointService.js';
import { normalizePlatformAlias } from '../../shared/platformIdentity.js';
import { probeRuntimeModel, type RuntimeModelProbeStatus } from './runtimeModelProbe.js';
import {
  isUsageLimitRateLimitFailure,
  matchesExplicitUsageLimitFailureText,
} from './usageLimitFailure.js';

const API_TOKEN_DISCOVERY_TIMEOUT_MS = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 12_000;
const MODEL_REFRESH_BATCH_SIZE = 3;
let inFlightRefreshModelsAndRebuildRoutes: Promise<{
  refresh: ModelRefreshResult[];
  rebuild: Awaited<ReturnType<typeof rebuildTokenRoutesFromAvailability>>;
}> | null = null;

type ModelRefreshErrorCode = 'timeout' | 'unauthorized' | 'rate_limited' | 'empty_models' | 'unknown';
type ModelRefreshSkipCode = 'site_disabled' | 'adapter_or_status';

export type ModelRefreshAccountNotFoundResult = {
  accountId: number;
  refreshed: false;
  status: 'failed';
  errorCode: 'account_not_found';
  errorMessage: '账号不存在';
  modelCount: 0;
  modelsPreview: string[];
  reason: 'account_not_found';
};

export type ModelRefreshSkippedResult = {
  accountId: number;
  refreshed: false;
  status: 'skipped';
  errorCode: ModelRefreshSkipCode;
  errorMessage: string;
  modelCount: 0;
  modelsPreview: string[];
  reason: ModelRefreshSkipCode;
};

export type ModelRefreshFailureResult = {
  accountId: number;
  refreshed: true;
  status: 'failed';
  errorCode: ModelRefreshErrorCode;
  errorMessage: string;
  modelCount: 0;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
};

export type ModelRefreshSuccessResult = {
  accountId: number;
  refreshed: true;
  status: 'success';
  errorCode: null;
  errorMessage: '';
  modelCount: number;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
  postProbeResult?: {
    scope: 'single' | 'all';
    probed: number;
    unsupported: number;
    details: Array<{
      modelName: string;
      status: RuntimeModelProbeStatus;
      latencyMs: number | null;
    }>;
  };
};

export type ModelRefreshResult =
  | ModelRefreshAccountNotFoundResult
  | ModelRefreshSkippedResult
  | ModelRefreshFailureResult
  | ModelRefreshSuccessResult;

function looksLikeHtmlJsonParseError(message: string): boolean {
  const lowered = String(message || '').trim().toLowerCase();
  return (
    lowered.includes('unexpected token')
    && lowered.includes('not valid json')
    && (lowered.includes('<html') || lowered.includes('<script'))
  );
}

function looksLikeShieldChallenge(message: string): boolean {
  const lowered = String(message || '').trim().toLowerCase();
  return (
    lowered.includes('acw_sc__v2')
    || lowered.includes('var arg1')
    || lowered.includes('captcha')
    || lowered.includes('challenge')
    || lowered.includes('cloudflare tunnel error')
  );
}

function classifyModelDiscoveryError(message: string): ModelRefreshErrorCode {
  const lowered = message.toLowerCase();
  if (lowered.includes('timeout') || lowered.includes('timed out') || lowered.includes('请求超时')) return 'timeout';
  if (isUsageLimitRateLimitFailure({ status: lowered.includes('429') ? 429 : null, message: lowered })
    || matchesExplicitUsageLimitFailureText(lowered)) return 'rate_limited';
  if (lowered.includes('http 401') || lowered.includes('http 403')
    || lowered.includes('unauthorized') || lowered.includes('invalid')
    || lowered.includes('无权') || lowered.includes('未提供令牌')) return 'unauthorized';
  return 'unknown';
}

function selectModelDiscoveryFailure(messages: string[]): {
  errorCode: ModelRefreshErrorCode;
  message: string;
} | null {
  const failures = messages.map((message) => ({
    errorCode: classifyModelDiscoveryError(message),
    message,
  }));
  const priority: ModelRefreshErrorCode[] = [
    'rate_limited',
    'timeout',
    'unauthorized',
    'unknown',
  ];

  for (const errorCode of priority) {
    const failure = failures.find((candidate) => candidate.errorCode === errorCode);
    if (failure) return failure;
  }
  return null;
}

function buildModelFailureMessage(code: ModelRefreshErrorCode, fallback?: string, platform?: string | null) {
  const raw = String(fallback || '').trim();
  if (looksLikeHtmlJsonParseError(raw) || looksLikeShieldChallenge(raw)) {
    const normalizedPlatform = normalizePlatformAlias(platform);
    if (normalizedPlatform === 'new-api') {
      return '模型获取失败：站点返回了防护页面，请在目标站点创建 API Key 后再同步模型';
    }
    return '模型获取失败：站点返回了网页而不是 JSON 响应';
  }
  if (code === 'timeout') return '模型获取失败（请求超时）';
  if (code === 'unauthorized') return '模型获取失败，API Key 已无效';
  if (code === 'rate_limited') return '模型获取失败：上游限额或频率限制';
  if (code === 'empty_models') return '模型获取失败：未获取到可用模型';
  return fallback || '模型获取失败';
}

function shouldRestorePreviousAvailabilityOnFailure(errorCode: ModelRefreshErrorCode): boolean {
  return errorCode !== 'unauthorized';
}

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function normalizeModels(models: string[]): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const rawModel of models) {
    if (typeof rawModel !== 'string') continue;
    const modelName = rawModel.trim();
    if (!modelName) continue;

    // Keep app/database behavior stable across SQLite/MySQL by deduping with a
    // case-insensitive key after trimming whitespace.
    const dedupeKey = modelName.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalizedModels.push(modelName);
  }

  return normalizedModels;
}

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildAccountNotFoundRefreshResult(accountId: number): ModelRefreshAccountNotFoundResult {
  return {
    accountId,
    refreshed: false,
    status: 'failed',
    errorCode: 'account_not_found',
    errorMessage: '账号不存在',
    modelCount: 0,
    modelsPreview: [],
    reason: 'account_not_found',
  };
}

function buildSkippedRefreshResult(
  accountId: number,
  code: ModelRefreshSkipCode,
  errorMessage: string,
): ModelRefreshSkippedResult {
  return {
    accountId,
    refreshed: false,
    status: 'skipped',
    errorCode: code,
    errorMessage,
    modelCount: 0,
    modelsPreview: [],
    reason: code,
  };
}

function buildFailedRefreshResult(input: {
  accountId: number;
  errorCode: ModelRefreshErrorCode;
  errorMessage: string;
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
}): ModelRefreshFailureResult {
  return {
    accountId: input.accountId,
    refreshed: true,
    status: 'failed',
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    modelCount: 0,
    modelsPreview: [],
    tokenScanned: input.tokenScanned,
    discoveredByCredential: input.discoveredByCredential,
    discoveredApiToken: input.discoveredApiToken,
  };
}

function buildSuccessfulRefreshResult(input: {
  accountId: number;
  modelCount: number;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
  postProbeResult?: ModelRefreshSuccessResult['postProbeResult'];
}): ModelRefreshSuccessResult {
  return {
    accountId: input.accountId,
    refreshed: true,
    status: 'success',
    errorCode: null,
    errorMessage: '',
    modelCount: input.modelCount,
    modelsPreview: input.modelsPreview,
    tokenScanned: input.tokenScanned,
    discoveredByCredential: input.discoveredByCredential,
    discoveredApiToken: input.discoveredApiToken,
    postProbeResult: input.postProbeResult,
  };
}

export type ProbeSiteModelsResult = {
  success: boolean;
  error?: string;
  scope: 'single' | 'all';
  probed: number;
  unsupported: number;
  details: Array<{ modelName: string; status: RuntimeModelProbeStatus; latencyMs: number | null; reason?: string }>;
};

export type ProbeSiteModelsProgress =
  | { type: 'start'; scope: 'single' | 'all'; modelsCount: number; modelsToProbe: string[] }
  | { type: 'model'; modelName: string; status: RuntimeModelProbeStatus; latencyMs: number | null; latencyExceeded?: true; reason?: string }
  | { type: 'action'; modelName: string; action: 'disabled' };

export async function probeSiteModels(
  siteId: number,
  options?: { scope?: 'single' | 'all'; modelName?: string; concurrency?: number; latencyThresholdMs?: number; signal?: AbortSignal },
  onProgress?: (event: ProbeSiteModelsProgress) => void,
): Promise<ProbeSiteModelsResult> {
  const empty = (scope: 'single' | 'all', error: string): ProbeSiteModelsResult =>
    ({ success: false, error, scope, probed: 0, unsupported: 0, details: [] });

  const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
  if (!site) return empty('single', '站点不存在');

  const account = await db.select().from(schema.accounts)
    .where(and(eq(schema.accounts.siteId, siteId), eq(schema.accounts.status, 'active')))
    .get();
  if (!account) return empty('single', '该站点没有可用的活跃账号');

  const modelRows = await db.select({ modelName: schema.modelAvailability.modelName })
    .from(schema.modelAvailability)
    .where(and(
      eq(schema.modelAvailability.accountId, account.id),
      eq(schema.modelAvailability.available, true),
    ))
    .all();

  const scope = (options?.scope ?? (site.postRefreshProbeScope === 'all' ? 'all' : 'single')) as 'single' | 'all';
  const availableModels = modelRows.map((r) => r.modelName.trim()).filter((m) => m.length > 0);
  if (availableModels.length === 0) {
    return empty(scope, '该站点暂无已发现模型，请先刷新模型列表');
  }

  let modelsToProbe: string[];
  if (scope === 'all') {
    modelsToProbe = availableModels;
  } else {
    const configModel = ((options?.modelName ?? site.postRefreshProbeModel) || '').trim().toLowerCase();
    const found = configModel
      ? (availableModels.find((m) => m.toLowerCase() === configModel) ?? availableModels[0])
      : availableModels[0];
    modelsToProbe = [found];
  }

  onProgress?.({ type: 'start', scope, modelsCount: modelsToProbe.length, modelsToProbe });

  // Probe models concurrently, limited by modelAvailabilityProbeConcurrency
  const concurrency = Math.max(1, options?.concurrency ?? 10);
  const detailsMap = new Map<string, { modelName: string; status: RuntimeModelProbeStatus; latencyMs: number | null; reason?: string }>();

  let cursor = 0;
  async function worker() {
    while (cursor < modelsToProbe.length) {
      if (options?.signal?.aborted) break;
      const modelName = modelsToProbe[cursor++];
      try {
        const result = await probeRuntimeModel({
          site, account, modelName, timeoutMs: config.modelAvailabilityProbeTimeoutMs,
        });
        const threshold = options?.latencyThresholdMs ?? 0;
        const latencyExceeded = (
          result.status === 'supported'
          && threshold > 0
          && result.latencyMs != null
          && result.latencyMs > threshold
        );
        const effectiveStatus: RuntimeModelProbeStatus = latencyExceeded ? 'unsupported' : result.status;
        const effectiveReason = latencyExceeded
          ? `响应延迟 ${result.latencyMs}ms 超过阈值 ${threshold}ms`
          : result.reason;
        detailsMap.set(modelName, { modelName, status: effectiveStatus, latencyMs: result.latencyMs, reason: effectiveReason });
        onProgress?.(latencyExceeded
          ? { type: 'model', modelName, status: effectiveStatus, latencyMs: result.latencyMs, latencyExceeded: true, reason: effectiveReason }
          : { type: 'model', modelName, status: effectiveStatus, latencyMs: result.latencyMs, reason: effectiveReason },
        );
      } catch (err) {
        const errReason = err instanceof Error ? err.message : '探测异常';
        console.warn(`[probe-site-now] probe failed for site ${siteId} model ${modelName}`, err);
        detailsMap.set(modelName, { modelName, status: 'inconclusive', latencyMs: null, reason: errReason });
        onProgress?.({ type: 'model', modelName, status: 'inconclusive', latencyMs: null, reason: errReason });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, modelsToProbe.length) }, worker));

  // Restore original model order for the final details list
  const details = modelsToProbe.map((m) => detailsMap.get(m)!);

  const unsupportedModels = details.filter((d) => d.status === 'unsupported' || d.status === 'inconclusive').map((d) => d.modelName);
  if (unsupportedModels.length > 0) {
    const checkedAt = new Date().toISOString();
    for (const modelName of unsupportedModels) {
      await db.update(schema.modelAvailability)
        .set({ available: false, checkedAt })
        .where(and(
          eq(schema.modelAvailability.accountId, account.id),
          eq(schema.modelAvailability.modelName, modelName),
        ))
        .run();
      await db.insert(schema.siteDisabledModels)
        .values({ siteId, modelName })
        .onConflictDoNothing()
        .run();
      onProgress?.({ type: 'action', modelName, action: 'disabled' });
    }
    const reason = unsupportedModels.length === 1
      ? `手动探测失败：模型 ${unsupportedModels[0]} 不可用`
      : `手动探测失败：${unsupportedModels.length} 个模型不可用（${unsupportedModels.slice(0, 3).join('、')}${unsupportedModels.length > 3 ? '…' : ''}）`;
    await setAccountRuntimeHealth(account.id, { state: 'unhealthy', reason, source: 'manual-probe', checkedAt });
    rebuildTokenRoutesFromAvailability().catch((err) => {
      console.warn('[probe-site-now] route rebuild failed', err);
    });
  }

  return { success: true, scope, probed: details.length, unsupported: unsupportedModels.length, details };
}

async function runPostRefreshProbeIfEnabled(params: {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  discoveredModels: string[];
}): Promise<ModelRefreshSuccessResult['postProbeResult']> {
  if (!params.site.postRefreshProbeEnabled) return undefined;
  if (params.discoveredModels.length === 0) return undefined;

  const scope = (params.site.postRefreshProbeScope === 'all' ? 'all' : 'single') as 'single' | 'all';

  // Determine which models to probe
  let modelsToProbe: string[];
  if (scope === 'all') {
    modelsToProbe = params.discoveredModels;
  } else {
    const configModel = (params.site.postRefreshProbeModel || '').trim().toLowerCase();
    const found = configModel
      ? (params.discoveredModels.find((m) => m.toLowerCase() === configModel) ?? params.discoveredModels[0])
      : params.discoveredModels[0];
    modelsToProbe = [found];
  }

  // runPostRefreshProbeIfEnabled: apply latency threshold from site config
  const threshold = params.site.postRefreshProbeLatencyThresholdMs ?? 0;
  // Probe each model sequentially
  const details: Array<{ modelName: string; status: RuntimeModelProbeStatus; latencyMs: number | null }> = [];
  for (const modelName of modelsToProbe) {
    try {
      const result = await probeRuntimeModel({
        site: params.site,
        account: params.account,
        modelName,
        timeoutMs: config.modelAvailabilityProbeTimeoutMs,
      });
      const latencyExceeded = (
        result.status === 'supported'
        && threshold > 0
        && result.latencyMs != null
        && result.latencyMs > threshold
      );
      const effectiveStatus: RuntimeModelProbeStatus = latencyExceeded ? 'unsupported' : result.status;
      details.push({ modelName, status: effectiveStatus, latencyMs: result.latencyMs });
    } catch (err) {
      console.warn(`[post-refresh-probe] probe failed for account ${params.account.id} model ${modelName}`, err);
      details.push({ modelName, status: 'inconclusive', latencyMs: null });
    }
  }

  // Handle unsupported models
  const unsupportedModels = details.filter((d) => d.status === 'unsupported' || d.status === 'inconclusive').map((d) => d.modelName);
  if (unsupportedModels.length > 0) {
    const checkedAt = new Date().toISOString();
    for (const modelName of unsupportedModels) {
      // Mark model as unavailable
      await db.update(schema.modelAvailability)
        .set({ available: false, checkedAt })
        .where(and(
          eq(schema.modelAvailability.accountId, params.account.id),
          eq(schema.modelAvailability.modelName, modelName),
        ))
        .run();
      // Add to site-level disabled models
      await db.insert(schema.siteDisabledModels)
        .values({ siteId: params.site.id, modelName })
        .onConflictDoNothing()
        .run();
    }
    // Update account health
    const reason = unsupportedModels.length === 1
      ? `刷新后探测失败：模型 ${unsupportedModels[0]} 不可用`
      : `刷新后探测失败：${unsupportedModels.length} 个模型不可用（${unsupportedModels.slice(0, 3).join('、')}${unsupportedModels.length > 3 ? '…' : ''}）`;
    await setAccountRuntimeHealth(params.account.id, {
      state: 'unhealthy',
      reason,
      source: 'post-refresh-probe',
      checkedAt,
    });
    // Single route rebuild for all changes
    rebuildTokenRoutesFromAvailability().catch((err) => {
      console.warn('[post-refresh-probe] route rebuild failed', err);
    });
  }

  return {
    scope,
    probed: details.length,
    unsupported: unsupportedModels.length,
    details,
  };
}

export async function refreshModelsForAccount(
  accountId: number,
  options?: { allowInactive?: boolean },
): Promise<ModelRefreshResult> {
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!row) {
    return buildAccountNotFoundRefreshResult(accountId);
  }

  const account = row.accounts;
  const site = row.sites;
  const adapter = getAdapter(site.platform);
  const accountProxyUrl = resolveProxyUrlFromExtraConfig(account.extraConfig);

  const previousAccountTokens = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();
  const previousModelAvailability = await db.select()
    .from(schema.modelAvailability)
    .where(and(
      eq(schema.modelAvailability.accountId, accountId),
      eq(schema.modelAvailability.isManual, false),
    ))
    .all();
  const previousTokenModelAvailability = (await Promise.all(previousAccountTokens.map(async (token) => db.select()
    .from(schema.tokenModelAvailability)
    .where(eq(schema.tokenModelAvailability.tokenId, token.id))
    .all()))).flat();

  // Collect manual model names so discovered/restored models that collide are skipped (unique index).
  const manualModelNames = new Set(
    (await db.select({ modelName: schema.modelAvailability.modelName })
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.isManual, true),
      ))
      .all()
    ).map((r) => r.modelName.toLowerCase()),
  );

  const previousTokenModelAvailabilityByTokenId = new Map<number, Array<typeof previousTokenModelAvailability[number]>>();
  for (const row of previousTokenModelAvailability) {
    const rows = previousTokenModelAvailabilityByTokenId.get(row.tokenId) || [];
    rows.push(row);
    previousTokenModelAvailabilityByTokenId.set(row.tokenId, rows);
  }
  const preservedAccountAvailabilityByName = new Map<string, typeof previousModelAvailability[number]>();

  const preservePreviousAccountAvailability = (modelNames?: Iterable<string>) => {
    const allowedNames = modelNames
      ? new Set(Array.from(modelNames).map((name) => name.toLowerCase()))
      : null;
    for (const row of previousModelAvailability) {
      const key = row.modelName.toLowerCase();
      if (allowedNames && !allowedNames.has(key)) continue;
      if (manualModelNames.has(key)) continue;
      preservedAccountAvailabilityByName.set(key, row);
    }
  };

  const clearExistingAvailability = async () => {
    await db.delete(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.isManual, false),
      ))
      .run();

    const currentAccountTokens = await db.select({ id: schema.accountTokens.id })
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, accountId))
      .all();

    for (const token of currentAccountTokens) {
      await db.delete(schema.tokenModelAvailability)
        .where(eq(schema.tokenModelAvailability.tokenId, token.id))
        .run();
    }
  };

  const restorePreviousAvailability = async (errorCode: ModelRefreshErrorCode) => {
    if (!shouldRestorePreviousAvailabilityOnFailure(errorCode)) return;
    await clearExistingAvailability();
    if (previousModelAvailability.length > 0) {
      await db.insert(schema.modelAvailability).values(
        previousModelAvailability.map(({ id: _id, ...row }) => row),
      ).run();
    }
    if (previousTokenModelAvailability.length > 0) {
      await db.insert(schema.tokenModelAvailability).values(
        previousTokenModelAvailability.map(({ id: _id, ...row }) => row),
      ).run();
    }
  };

  const restorePreviousTokenAvailability = async (tokenId: number, errorCode: ModelRefreshErrorCode) => {
    if (!shouldRestorePreviousAvailabilityOnFailure(errorCode)) return;
    const rows = previousTokenModelAvailabilityByTokenId.get(tokenId) || [];
    if (rows.length === 0) return;

    await db.delete(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, tokenId))
      .run();
    await db.insert(schema.tokenModelAvailability).values(
      rows.map(({ id: _id, ...row }) => row),
    ).run();
    preservePreviousAccountAvailability(rows.map((row) => row.modelName));
  };

  let restoredAllPreviousTokenAvailability = false;
  const restoreAllPreviousTokenAvailability = async (errorCode: ModelRefreshErrorCode) => {
    if (restoredAllPreviousTokenAvailability) return;
    if (!shouldRestorePreviousAvailabilityOnFailure(errorCode)) return;
    if (previousTokenModelAvailability.length === 0) return;
    await db.insert(schema.tokenModelAvailability).values(
      previousTokenModelAvailability.map(({ id: _id, ...row }) => row),
    ).run();
    restoredAllPreviousTokenAvailability = true;
  };

  const restorePreservedAccountAvailability = async (
    rows = Array.from(preservedAccountAvailabilityByName.values()),
  ) => {
    if (rows.length === 0) return;
    await db.insert(schema.modelAvailability).values(
      rows.map(({ id: _id, ...row }) => row),
    ).run();
  };

  await clearExistingAvailability();

  if (isSiteDisabled(site.status)) {
    return buildSkippedRefreshResult(accountId, 'site_disabled', '站点已禁用');
  }

  if (account.status !== 'active' && !options?.allowInactive) {
    return buildSkippedRefreshResult(accountId, 'adapter_or_status', '平台不可用或账号未激活');
  }





  if (!adapter) {
    return buildSkippedRefreshResult(accountId, 'adapter_or_status', '平台不可用或账号未激活');
  }

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  let discoveredApiToken: string | null = null;

  if (!account.apiToken && account.accessToken) {
    try {
      discoveredApiToken = await withTimeout(
        () => withAccountProxyOverride(accountProxyUrl,
          () => adapter.getApiToken(site.url, account.accessToken, platformUserId)),
        API_TOKEN_DISCOVERY_TIMEOUT_MS,
        `api token discovery timeout (${Math.round(API_TOKEN_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
      );
      if (discoveredApiToken && !isMaskedTokenValue(discoveredApiToken)) {
        await ensureDefaultTokenForAccount(account.id, discoveredApiToken, { name: 'default', source: 'sync' });
        await db.update(schema.accounts).set({
          apiToken: discoveredApiToken,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.accounts.id, account.id)).run();
      } else {
        discoveredApiToken = null;
      }
    } catch { }
  }

  const usesManagedTokens = requiresManagedAccountTokens(account);
  let enabledTokens = usesManagedTokens
    ? await db.select()
      .from(schema.accountTokens)
      .where(and(
        eq(schema.accountTokens.accountId, account.id),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      ))
      .all()
    : [];
  enabledTokens = enabledTokens.filter(isUsableAccountToken);

  // Last fallback: if still no managed token but account has a legacy apiToken, mirror it into token table.
  if (usesManagedTokens && enabledTokens.length === 0) {
    const fallback = discoveredApiToken || account.apiToken || null;
    if (fallback) {
      await ensureDefaultTokenForAccount(account.id, fallback, { name: 'default', source: 'legacy' });
      enabledTokens = await db.select()
        .from(schema.accountTokens)
        .where(and(
          eq(schema.accountTokens.accountId, account.id),
          eq(schema.accountTokens.enabled, true),
          eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        ))
        .all();
      enabledTokens = enabledTokens.filter(isUsableAccountToken);
    }
  }

  let aiBaseUrl: string;
  try {
    aiBaseUrl = await requireSiteApiBaseUrl(site);
  } catch (err) {
    const rawMessage = (err as { message?: string })?.message || '模型获取失败';
    const errorCode = classifyModelDiscoveryError(rawMessage);
    const errorMessage = rawMessage;
    await setAccountRuntimeHealth(account.id, {
      state: 'unhealthy',
      reason: errorMessage,
      source: 'model-discovery',
      checkedAt: new Date().toISOString(),
    });
    await restorePreviousAvailability(errorCode);
    return buildFailedRefreshResult({
      accountId,
      errorCode,
      errorMessage,
      tokenScanned: 0,
      discoveredByCredential: false,
      discoveredApiToken: !!discoveredApiToken,
    });
  }

  const accountModels = new Map<string, string>();   // lowercase key → original name (first-wins)
  const modelLatency = new Map<string, number | null>();
  let scannedTokenCount = 0;
  let discoveredByCredential = false;
  const attemptedCredentials = new Set<string>();
  const failureMessages: string[] = [];
  const recordFailure = (err: unknown): string => {
    const message = (err as { message?: string })?.message || String(err || '');
    if (message) failureMessages.push(message);
    return message;
  };

  const mergeDiscoveredModels = (models: string[], latencyMs: number | null) => {
    for (const modelName of models) {
      const key = modelName.toLowerCase();
      if (!accountModels.has(key)) accountModels.set(key, modelName);
      const prev = modelLatency.get(key);
      if (prev === undefined || prev === null) {
        modelLatency.set(key, latencyMs);
        continue;
      }
      if (latencyMs === null) continue;
      if (latencyMs < prev) modelLatency.set(key, latencyMs);
    }
  };

  const discoverModelsWithCredential = async (credentialRaw: string | null | undefined) => {
    const credential = (credentialRaw || '').trim();
    if (!credential) return;
    if (isMaskedTokenValue(credential)) return;
    if (attemptedCredentials.has(credential)) return;
    attemptedCredentials.add(credential);

    const startedAt = Date.now();
    let models: string[] = [];
    let preserveOnEmptyCode: ModelRefreshErrorCode = 'empty_models';
    try {
      models = normalizeModels(
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => adapter.getModels(aiBaseUrl, credential, platformUserId)),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      );
    } catch (err) {
      const message = recordFailure(err);
      const errorCode = classifyModelDiscoveryError(message);
      preserveOnEmptyCode = errorCode;
      models = [];
    }
    if (models.length === 0) {
      if ((!usesManagedTokens || options?.allowInactive === true)
        && shouldRestorePreviousAvailabilityOnFailure(preserveOnEmptyCode)) {
        preservePreviousAccountAvailability();
        if (!usesManagedTokens) {
          await restoreAllPreviousTokenAvailability(preserveOnEmptyCode);
        }
      }
      return;
    }
    discoveredByCredential = true;
    const latencyMs = Date.now() - startedAt;
    mergeDiscoveredModels(models, latencyMs);
  };

  // Prefer account-level credential discovery so model availability does not rely on managed tokens.
  await discoverModelsWithCredential(account.apiToken);
  await discoverModelsWithCredential(discoveredApiToken);
  await discoverModelsWithCredential(account.accessToken);

  for (const token of enabledTokens) {
    const startedAt = Date.now();
    let models: string[] = [];
    let preserveOnEmptyCode: ModelRefreshErrorCode = 'empty_models';

    try {
      models = normalizeModels(
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => adapter.getModels(aiBaseUrl, token.token, platformUserId)),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      );
    } catch (err) {
      const message = recordFailure(err);
      const errorCode = classifyModelDiscoveryError(message);
      preserveOnEmptyCode = errorCode;
      models = [];
    }

    if (models.length === 0) {
      await restorePreviousTokenAvailability(token.id, preserveOnEmptyCode);
      continue;
    }

    const latencyMs = Date.now() - startedAt;
    const checkedAt = new Date().toISOString();

    await db.insert(schema.tokenModelAvailability).values(
      models.map((modelName) => ({
        tokenId: token.id,
        modelName,
        available: true,
        latencyMs,
        checkedAt,
      })),
    ).run();

    scannedTokenCount++;
    mergeDiscoveredModels(models, latencyMs);
  }

  if (accountModels.size === 0) {
    const selectedFailure = selectModelDiscoveryFailure(failureMessages);
    const errorCode = selectedFailure?.errorCode ?? 'empty_models';
    const failureMessage = selectedFailure?.message ?? '';
    const errorMessage = buildModelFailureMessage(errorCode, failureMessage, site.platform);
    await setAccountRuntimeHealth(account.id, {
      state: 'unhealthy',
      reason: errorMessage,
      source: 'model-discovery',
      checkedAt: new Date().toISOString(),
    });
    await restorePreservedAccountAvailability();
    return buildFailedRefreshResult({
      accountId,
      errorCode,
      errorMessage,
      tokenScanned: scannedTokenCount,
      discoveredByCredential,
      discoveredApiToken: !!discoveredApiToken,
    });
  }

  const checkedAt = new Date().toISOString();
  const newAccountModels = Array.from(accountModels.values()).filter((m) => !manualModelNames.has(m.toLowerCase()));
  const newAccountModelNames = new Set(newAccountModels.map((modelName) => modelName.toLowerCase()));
  const preservedAccountRows = Array.from(preservedAccountAvailabilityByName.values())
    .filter((row) => {
      const key = row.modelName.toLowerCase();
      return !manualModelNames.has(key) && !newAccountModelNames.has(key);
    });
  if (newAccountModels.length > 0) {
    await db.insert(schema.modelAvailability).values(
      newAccountModels.map((modelName) => ({
        accountId: account.id,
        modelName,
        available: true,
        latencyMs: modelLatency.get(modelName.toLowerCase()) ?? null,
        checkedAt,
      })),
    ).run();
  }
  if (preservedAccountRows.length > 0) {
    await restorePreservedAccountAvailability(preservedAccountRows);
  }

  await setAccountRuntimeHealth(account.id, {
    state: 'healthy',
    reason: '模型探测成功',
    source: 'model-discovery',
    checkedAt,
  });

  const availableAccountModels = [
    ...Array.from(accountModels.values()),
    ...preservedAccountRows.map((row) => row.modelName),
  ];
  const modelsPreview = availableAccountModels.slice(0, 10);
  const standardPostProbeResult = await runPostRefreshProbeIfEnabled({
    account,
    site,
    discoveredModels: availableAccountModels,
  });
  return buildSuccessfulRefreshResult({
    accountId,
    modelCount: availableAccountModels.length,
    modelsPreview,
    tokenScanned: scannedTokenCount,
    discoveredByCredential,
    discoveredApiToken: !!discoveredApiToken,
    postProbeResult: standardPostProbeResult,
  });
}

async function refreshModelsForAllActiveAccounts(): Promise<ModelRefreshResult[]> {
  const accounts = await db.select({ id: schema.accounts.id }).from(schema.accounts)
    .where(eq(schema.accounts.status, 'active'))
    .all();

  const results: ModelRefreshResult[] = [];
  for (let offset = 0; offset < accounts.length; offset += MODEL_REFRESH_BATCH_SIZE) {
    const batch = accounts.slice(offset, offset + MODEL_REFRESH_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (account) => refreshModelsForAccount(account.id)));
    results.push(...batchResults);
  }
  return results;
}

export async function rebuildTokenRoutesFromAvailability() {
  const tokenRows = await db.select().from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();
  const usableTokenRows = tokenRows.filter((row) => (
    isUsableAccountToken(row.account_tokens)
    && requiresManagedAccountTokens(row.accounts)
  ));

  const accountRows = await db.select().from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.modelAvailability.available, true),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  // Load site-level disabled models
  const disabledModelRows = await db.select().from(schema.siteDisabledModels).all();
  const disabledModelsBySite = new Map<number, Set<string>>();
  for (const row of disabledModelRows) {
    if (!disabledModelsBySite.has(row.siteId)) disabledModelsBySite.set(row.siteId, new Set());
    disabledModelsBySite.get(row.siteId)!.add(row.modelName.toLowerCase());
  }

  function isModelDisabledForSite(siteId: number, modelName: string): boolean {
    const disabled = disabledModelsBySite.get(siteId);
    return !!disabled && disabled.has(modelName.toLowerCase());
  }

  // Load global brand filter
  const blockedBrandRules = getBlockedBrandRules(config.globalBlockedBrands);

  // Load global allowed models whitelist
  const globalAllowedModels = new Set(
    config.globalAllowedModels.map((m) => m.toLowerCase().trim()).filter(Boolean),
  );

  function isModelAllowedByWhitelist(modelName: string): boolean {
    // If whitelist is empty, allow all models (backward compatible)
    if (globalAllowedModels.size === 0) return true;
    // Check if model is in whitelist (case-insensitive)
    return globalAllowedModels.has(modelName.toLowerCase().trim());
  }

  const modelCandidates = new Map<string, Map<string, {
    accountId: number;
    tokenId: number | null;
  }>>();
  const buildCandidateKey = (input: {
    accountId: number;
    tokenId: number | null;
  }) => `${input.accountId}:${input.tokenId ?? 'account'}`;
  const buildChannelKey = (channel: typeof schema.routeChannels.$inferSelect) => (
    `${channel.accountId}:${channel.tokenId ?? 'account'}`
  );
  const addModelCandidate = (
    modelNameRaw: string | null | undefined,
    accountId: number,
    tokenId: number | null,
    siteId: number,
  ) => {
    const modelName = (modelNameRaw || '').trim();
    if (!modelName) return;
    if (!isModelAllowedByWhitelist(modelName)) return;
    if (isModelDisabledForSite(siteId, modelName)) return;
    if (blockedBrandRules.length > 0 && isModelBlockedByBrand(modelName, blockedBrandRules)) return;
    if (!modelCandidates.has(modelName)) modelCandidates.set(modelName, new Map());
    const candidate = { accountId, tokenId };
    modelCandidates.get(modelName)!.set(buildCandidateKey(candidate), candidate);
  };

  for (const row of usableTokenRows) {
    addModelCandidate(row.token_model_availability.modelName, row.accounts.id, row.account_tokens.id, row.accounts.siteId);
  }

  for (const row of accountRows) {
    if (!supportsDirectAccountRoutingConnection(row.accounts)) continue;
    addModelCandidate(row.model_availability.modelName, row.accounts.id, null, row.accounts.siteId);
  }

  const routes = await db.select().from(schema.tokenRoutes).all();
  const channels = await db.select().from(schema.routeChannels).all();

  let createdRoutes = 0;
  let createdChannels = 0;
  let removedChannels = 0;
  let removedRoutes = 0;

  for (const [modelName, candidateMap] of modelCandidates.entries()) {
    let route = routes.find((r) => (r.routeMode || 'pattern') !== 'explicit_group' && r.modelPattern === modelName);
    if (!route) {
      const inserted = await db.insert(schema.tokenRoutes).values({
        modelPattern: modelName,
        enabled: true,
      }).run();
      const insertedId = getInsertedRowId(inserted);
      route = insertedId != null
        ? await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, insertedId)).get()
        : undefined;
      if (!route) continue;
      routes.push(route);
      createdRoutes++;
    }

    const routeChannels = channels.filter((channel) => channel.routeId === route.id);
    const desiredKeys = new Set(Array.from(candidateMap.keys()));

    for (const [candidateKey, candidate] of candidateMap.entries()) {
      const exists = routeChannels.some((channel) => buildChannelKey(channel) === candidateKey);
      if (exists) continue;

      const inserted = await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: candidate.accountId,
        tokenId: candidate.tokenId,
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      }).run();
      const insertedId = getInsertedRowId(inserted);
      if (insertedId == null) continue;
      const created = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, insertedId)).get();
      if (!created) continue;
      channels.push(created);
      createdChannels++;
      desiredKeys.add(candidateKey);
    }

    for (const channel of routeChannels) {
      const channelKey = buildChannelKey(channel);
      if (desiredKeys.has(channelKey)) {
        continue;
      }

      if (!channel.tokenId) {
        const preferred = await getPreferredAccountToken(channel.accountId);
        if (preferred && desiredKeys.has(`${channel.accountId}:${preferred.id}`)) {
          await db.update(schema.routeChannels)
            .set({ tokenId: preferred.id })
            .where(eq(schema.routeChannels.id, channel.id))
            .run();
          continue;
        }
      }

      if (!channel.manualOverride) {
        await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
        removedChannels++;
      }
    }
  }

  const latestModelNames = new Set<string>(Array.from(modelCandidates.keys()));
  for (const route of routes) {
    if ((route.routeMode || 'pattern') === 'explicit_group') {
      continue;
    }
    const modelPattern = (route.modelPattern || '').trim();
    if (!modelPattern || !isExactModelPattern(modelPattern) || latestModelNames.has(modelPattern)) {
      continue;
    }

    const routeChannelCount = channels.filter((channel) => channel.routeId === route.id).length;
    if (routeChannelCount > 0) {
      removedChannels += routeChannelCount;
    }

    const deleted = (await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, route.id)).run()).changes;
    if (deleted > 0) {
      removedRoutes += deleted;
    }
  }

  if (createdRoutes > 0 || createdChannels > 0 || removedChannels > 0 || removedRoutes > 0) {
    await clearAllRouteDecisionSnapshots();
  }

  invalidateTokenRouterCache();

  return {
    models: modelCandidates.size,
    createdRoutes,
    createdChannels,
    removedChannels,
    removedRoutes,
  };
}

async function runRefreshModelsAndRebuildRoutes() {
  const refresh = await refreshModelsForAllActiveAccounts();
  const rebuild = await rebuildTokenRoutesFromAvailability();
  return { refresh, rebuild };
}

export async function refreshModelsAndRebuildRoutes() {
  if (inFlightRefreshModelsAndRebuildRoutes) {
    return inFlightRefreshModelsAndRebuildRoutes;
  }

  inFlightRefreshModelsAndRebuildRoutes = (async () => {
    try {
      return await runRefreshModelsAndRebuildRoutes();
    } finally {
      inFlightRefreshModelsAndRebuildRoutes = null;
    }
  })();

  return inFlightRefreshModelsAndRebuildRoutes;
}
