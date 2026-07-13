import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { fetchModelsDevPrices } from './modelsDevPriceSource.js';
import { fetchSitePrices, SitePriceSourceError } from './sitePriceSource.js';
import {
  getPricingRefreshState,
  replaceOfficialPriceSnapshot,
  replaceSitePriceSnapshot,
  upsertPricingRefreshState,
} from './pricingRepository.js';
import type { OfficialModelPriceInput, SitePriceInput } from './contracts.js';

export const PRICE_REFRESH_CONCURRENCY = 3;
export type PriceRefreshFailureKind = 'auth' | 'timeout' | 'invalid_response' | 'upstream' | 'storage' | 'unsupported';

const SAFE_FAILURE_MESSAGES: Record<PriceRefreshFailureKind, string> = {
  auth: '价格刷新凭据不可用',
  timeout: '价格刷新请求超时',
  invalid_response: '上游价格响应无效',
  upstream: '上游价格请求失败',
  storage: '价格快照保存失败',
  unsupported: '站点平台不支持价格获取',
};

export interface PriceRefreshPassResult {
  officialRefreshed: boolean;
  siteScanned: number;
  siteRefreshed: number;
  siteFailed: number;
  refreshedSiteIds: number[];
  failedSiteIds: number[];
}

export interface PriceRefreshPassInput {
  siteId?: number;
  signal?: AbortSignal;
}

export interface PriceRefreshDependencies {
  fetchModelsDevPrices: (signal?: AbortSignal) => Promise<OfficialModelPriceInput[]>;
  replaceOfficialPriceSnapshot: (rows: OfficialModelPriceInput[]) => Promise<void>;
  listEnabledSiteIds: () => Promise<number[]>;
  fetchSitePrices: (siteId: number, signal?: AbortSignal) => Promise<SitePriceInput[]>;
  replaceSitePriceSnapshot: (siteId: number, rows: SitePriceInput[]) => Promise<void>;
  recordSuccess: (scope: 'official' | 'site', scopeId: number) => Promise<void>;
  recordFailure: (scope: 'official' | 'site', scopeId: number, kind: PriceRefreshFailureKind) => Promise<void>;
  recordPassResult?: (result: PriceRefreshPassResult) => Promise<void>;
}

async function listEnabledSiteIds(): Promise<number[]> {
  const rows = await db.select({ id: schema.sites.id }).from(schema.sites)
    .where(eq(schema.sites.status, 'active'))
    .orderBy(asc(schema.sites.id))
    .all();
  return rows.map((row) => row.id);
}

async function createRefreshEvent(
  scope: 'official' | 'site',
  scopeId: number,
  title: string,
  message: string,
  level: 'info' | 'warning',
): Promise<void> {
  await db.insert(schema.events).values({
    type: 'status',
    title,
    message,
    level,
    relatedId: scope === 'site' ? scopeId : null,
    relatedType: scope === 'site' ? 'site' : null,
    createdAt: new Date().toISOString(),
  }).run();
}

async function recordSuccess(scope: 'official' | 'site', scopeId: number): Promise<void> {
  const previous = await getPricingRefreshState(scope, scopeId);
  const now = new Date().toISOString();
  await upsertPricingRefreshState(scope, scopeId, {
    lastSuccessAt: now,
    failureActive: false,
  });
  if (previous?.failureActive) {
    await createRefreshEvent(scope, scopeId, '价格刷新已恢复', '价格刷新已恢复正常', 'info');
  }
}

async function recordFailure(
  scope: 'official' | 'site',
  scopeId: number,
  kind: PriceRefreshFailureKind,
): Promise<void> {
  const previous = await getPricingRefreshState(scope, scopeId);
  await upsertPricingRefreshState(scope, scopeId, {
    lastFailureAt: new Date().toISOString(),
    lastFailureKind: kind,
    failureActive: true,
  });
  if (!previous?.failureActive) {
    await createRefreshEvent(scope, scopeId, '价格刷新失败', SAFE_FAILURE_MESSAGES[kind], 'warning');
  }
}

async function recordPassResult(result: PriceRefreshPassResult): Promise<void> {
  await createRefreshEvent(
    'official',
    0,
    result.officialRefreshed ? '价格刷新完成' : '价格刷新失败',
    result.officialRefreshed
      ? `官方目录已更新，站点刷新成功 ${result.siteRefreshed}/${result.siteScanned}，失败 ${result.siteFailed}`
      : '官方价格目录刷新失败，未继续刷新站点价格',
    !result.officialRefreshed || result.siteFailed > 0 ? 'warning' : 'info',
  );
}

function createOfficialFailureResult(): PriceRefreshPassResult {
  return {
    officialRefreshed: false,
    siteScanned: 0,
    siteRefreshed: 0,
    siteFailed: 0,
    refreshedSiteIds: [],
    failedSiteIds: [],
  };
}

function classifyFailure(error: unknown): PriceRefreshFailureKind {
  if (error instanceof SitePriceSourceError) {
    if (error.kind === 'unsupported') return 'unsupported';
    if (error.kind === 'no_credentials') return 'auth';
    if (error.kind === 'invalid_response') return 'invalid_response';
  }
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (name === 'timeouterror' || message.includes('timeout')) return 'timeout';
  if (message.includes('invalid')) return 'invalid_response';
  return 'upstream';
}

const defaultDependencies: PriceRefreshDependencies = {
  fetchModelsDevPrices,
  replaceOfficialPriceSnapshot,
  listEnabledSiteIds,
  fetchSitePrices,
  replaceSitePriceSnapshot,
  recordSuccess,
  recordFailure,
  recordPassResult,
};

export async function refreshSitePriceSnapshot(
  siteId: number,
  signal?: AbortSignal,
  deps: PriceRefreshDependencies = defaultDependencies,
): Promise<void> {
  signal?.throwIfAborted();
  let rows: SitePriceInput[];
  try {
    rows = await deps.fetchSitePrices(siteId, signal);
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    await deps.recordFailure('site', siteId, classifyFailure(error));
    throw error;
  }
  try {
    await deps.replaceSitePriceSnapshot(siteId, rows);
  } catch (error) {
    await deps.recordFailure('site', siteId, 'storage');
    throw error;
  }
  await deps.recordSuccess('site', siteId);
}

export async function runPriceRefreshPass(
  input: PriceRefreshPassInput = {},
  deps: PriceRefreshDependencies = defaultDependencies,
): Promise<PriceRefreshPassResult> {
  input.signal?.throwIfAborted();
  let officialRows: OfficialModelPriceInput[];
  try {
    officialRows = await deps.fetchModelsDevPrices(input.signal);
    input.signal?.throwIfAborted();
  } catch (error) {
    input.signal?.throwIfAborted();
    await deps.recordFailure('official', 0, classifyFailure(error));
    await deps.recordPassResult?.(createOfficialFailureResult());
    throw new Error('official price refresh failed');
  }
  try {
    await deps.replaceOfficialPriceSnapshot(officialRows);
  } catch (error) {
    input.signal?.throwIfAborted();
    await deps.recordFailure('official', 0, 'storage');
    await deps.recordPassResult?.(createOfficialFailureResult());
    throw new Error('official price refresh failed');
  }
  await deps.recordSuccess('official', 0);

  const enabledSiteIds = input.siteId ? [input.siteId] : await deps.listEnabledSiteIds();
  const result: PriceRefreshPassResult = {
    officialRefreshed: true,
    siteScanned: enabledSiteIds.length,
    siteRefreshed: 0,
    siteFailed: 0,
    refreshedSiteIds: [],
    failedSiteIds: [],
  };
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < enabledSiteIds.length) {
      input.signal?.throwIfAborted();
      const siteId = enabledSiteIds[nextIndex++];
      try {
        await refreshSitePriceSnapshot(siteId, input.signal, deps);
        result.siteRefreshed += 1;
        result.refreshedSiteIds.push(siteId);
      } catch (error) {
        input.signal?.throwIfAborted();
        result.siteFailed += 1;
        result.failedSiteIds.push(siteId);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PRICE_REFRESH_CONCURRENCY, enabledSiteIds.length) }, () => worker()),
  );
  await deps.recordPassResult?.(result);
  return result;
}
