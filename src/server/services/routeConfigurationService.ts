import { and, eq, inArray } from 'drizzle-orm';
import type {
  RouteChannelBatchCreatePayload,
  RouteChannelCreatePayload,
  RouteChannelUpdatePayload,
  TokenRouteCreatePayload,
  TokenRouteUpdatePayload,
} from '../contracts/tokenRoutePayloads.js';
import { db, schema } from '../db/index.js';
import { requireInsertedRowId } from '../db/insertHelpers.js';
import { normalizeTokenRouteMode, type RouteMode } from '../../shared/tokenRouteContract.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  isUsableAccountToken,
} from './accountTokenService.js';
import {
  clearRouteDecisionSnapshot,
  clearRouteDecisionSnapshots,
} from './routeDecisionSnapshotStore.js';
import { runRouteProjectionExclusive } from './routeProjectionCoordinator.js';
import {
  DEFAULT_ROUTE_ROUTING_STRATEGY,
  normalizeRouteRoutingStrategy,
  type RouteRoutingStrategy,
} from './routeRoutingStrategy.js';
import { findSiteModelAliasRouteNameConflict } from './siteModelAliasService.js';
import { invalidateTokenRouterCache, matchesModelPattern } from './tokenRouter.js';

type DbClient = typeof db;

export type RouteRow = typeof schema.tokenRoutes.$inferSelect & {
  routeMode: RouteMode;
  sourceRouteIds: number[];
};

export type RouteChannelPriorityUpdate = {
  id: number;
  priority: number;
};

/** 为 API 适配层提供可映射为 HTTP 状态码的路由配置异常。 */
export class RouteConfigurationMutationError extends Error {
  readonly statusCode: 400 | 404 | 409 | 500;
  readonly code?: string;

  constructor(statusCode: 400 | 404 | 409 | 500, message: string, code?: string) {
    super(message);
    this.name = 'RouteConfigurationMutationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** 判断路由表达式是否为精确模型，而不是通配符或正则群组。 */
export function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

function normalizeRouteMode(routeMode: unknown): RouteMode {
  return normalizeTokenRouteMode(routeMode);
}

/** 判断路由是否为由来源路由 ID 显式组成的群组。 */
export function isExplicitGroupRoute(
  route: Pick<RouteRow, 'routeMode'> | Pick<typeof schema.tokenRoutes.$inferSelect, 'routeMode'>,
): boolean {
  return normalizeRouteMode(route.routeMode) === 'explicit_group';
}

/** 判断路由是否为系统维护的站点模型别名投影。 */
export function isManagedSiteAliasRoute(
  route: Pick<typeof schema.tokenRoutes.$inferSelect, 'routeKind'>,
): boolean {
  return route.routeKind === 'site_alias';
}

function normalizeSourceRouteIdsInput(input: unknown): number[] {
  const rawValues = Array.isArray(input) ? input : [];
  const normalized: number[] = [];
  for (const raw of rawValues) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const routeId = Math.trunc(value);
    if (routeId <= 0 || normalized.includes(routeId)) continue;
    normalized.push(routeId);
    if (normalized.length >= 500) break;
  }
  return normalized;
}

async function loadRouteSourceIdsMap(
  routeIds: number[],
  client: DbClient = db,
): Promise<Map<number, number[]>> {
  const normalizedRouteIds = Array.from(new Set(
    routeIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0),
  ));
  if (normalizedRouteIds.length === 0) return new Map();

  const rows = await client.select().from(schema.routeGroupSources)
    .where(inArray(schema.routeGroupSources.groupRouteId, normalizedRouteIds))
    .all();
  const sourceRouteIdsByRouteId = new Map<number, number[]>();
  for (const row of rows) {
    if (!sourceRouteIdsByRouteId.has(row.groupRouteId)) {
      sourceRouteIdsByRouteId.set(row.groupRouteId, []);
    }
    sourceRouteIdsByRouteId.get(row.groupRouteId)!.push(row.sourceRouteId);
  }
  for (const [routeId, sourceRouteIds] of sourceRouteIdsByRouteId.entries()) {
    sourceRouteIdsByRouteId.set(routeId, Array.from(new Set(sourceRouteIds)));
  }
  return sourceRouteIdsByRouteId;
}

function decorateRoutesWithSources(
  routes: Array<typeof schema.tokenRoutes.$inferSelect>,
  sourceRouteIdsByRouteId: Map<number, number[]>,
): RouteRow[] {
  return routes.map((route) => ({
    ...route,
    routeMode: normalizeRouteMode(route.routeMode),
    sourceRouteIds: sourceRouteIdsByRouteId.get(route.id) ?? [],
  }));
}

/** 列出路由，并为每条显式群组路由附加其来源路由 ID。 */
export async function listRoutesWithSources(client: DbClient = db): Promise<RouteRow[]> {
  const routes = await client.select().from(schema.tokenRoutes).all();
  const sourceRouteIdsByRouteId = await loadRouteSourceIdsMap(
    routes.map((route) => route.id),
    client,
  );
  return decorateRoutesWithSources(routes, sourceRouteIdsByRouteId);
}

/** 读取单条路由，并附加其显式群组来源路由 ID。 */
export async function getRouteWithSources(
  routeId: number,
  client: DbClient = db,
): Promise<RouteRow | null> {
  const route = await client.select().from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.id, routeId))
    .get();
  if (!route) return null;
  const sourceRouteIdsByRouteId = await loadRouteSourceIdsMap([routeId], client);
  return decorateRoutesWithSources([route], sourceRouteIdsByRouteId)[0] ?? null;
}

async function validateExplicitGroupSourceRoutes(
  sourceRouteIds: number[],
  currentRouteId: number | undefined,
  client: DbClient,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (sourceRouteIds.length === 0) {
    return { ok: false, message: '显式群组至少需要选择一个来源模型' };
  }

  const routes = await client.select().from(schema.tokenRoutes)
    .where(inArray(schema.tokenRoutes.id, sourceRouteIds))
    .all();
  if (routes.length !== sourceRouteIds.length) {
    return { ok: false, message: '来源模型中存在不存在的路由' };
  }

  for (const route of routes) {
    if (currentRouteId && route.id === currentRouteId) {
      return { ok: false, message: '显式群组不能引用自身作为来源模型' };
    }
    if (isManagedSiteAliasRoute(route)) {
      return { ok: false, message: '显式群组不能引用系统维护的站点模型别名路由' };
    }
    if (normalizeRouteMode(route.routeMode) === 'explicit_group') {
      return { ok: false, message: '显式群组只能选择精确模型路由作为来源模型' };
    }
    if (!isExactModelPattern(route.modelPattern)) {
      return { ok: false, message: '显式群组只能选择精确模型路由作为来源模型' };
    }
  }

  return { ok: true };
}

async function replaceRouteSourceRouteIds(
  routeId: number,
  sourceRouteIds: number[],
  client: DbClient,
): Promise<void> {
  await client.delete(schema.routeGroupSources)
    .where(eq(schema.routeGroupSources.groupRouteId, routeId))
    .run();
  if (sourceRouteIds.length === 0) return;
  await client.insert(schema.routeGroupSources).values(
    sourceRouteIds.map((sourceRouteId) => ({
      groupRouteId: routeId,
      sourceRouteId,
    })),
  ).run();
}

async function syncExplicitGroupSourceRouteStrategies(input: {
  groupRouteId: number;
  sourceRouteIds: number[];
  targetStrategy: RouteRoutingStrategy;
  previousStrategy?: RouteRoutingStrategy | null;
  client: DbClient;
}): Promise<number[]> {
  const normalizedSourceRouteIds = Array.from(new Set(
    input.sourceRouteIds.filter((routeId): routeId is number => Number.isFinite(routeId) && routeId > 0),
  ));
  if (normalizedSourceRouteIds.length === 0) return [];

  const [sourceRoutes, sourceGroupRows] = await Promise.all([
    input.client.select().from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, normalizedSourceRouteIds))
      .all(),
    input.client.select({
      groupRouteId: schema.routeGroupSources.groupRouteId,
      sourceRouteId: schema.routeGroupSources.sourceRouteId,
    }).from(schema.routeGroupSources)
      .where(inArray(schema.routeGroupSources.sourceRouteId, normalizedSourceRouteIds))
      .all(),
  ]);

  const otherGroupRefsBySourceRouteId = new Map<number, Set<number>>();
  for (const row of sourceGroupRows) {
    if (row.groupRouteId === input.groupRouteId) continue;
    if (!otherGroupRefsBySourceRouteId.has(row.sourceRouteId)) {
      otherGroupRefsBySourceRouteId.set(row.sourceRouteId, new Set());
    }
    otherGroupRefsBySourceRouteId.get(row.sourceRouteId)!.add(row.groupRouteId);
  }

  const previousStrategy = input.previousStrategy
    ? normalizeRouteRoutingStrategy(input.previousStrategy)
    : null;
  const updatableRouteIds: number[] = [];
  for (const route of sourceRoutes) {
    if (normalizeRouteMode(route.routeMode) === 'explicit_group') continue;
    if (!isExactModelPattern(route.modelPattern)) continue;
    if ((otherGroupRefsBySourceRouteId.get(route.id)?.size || 0) > 0) continue;

    const currentStrategy = normalizeRouteRoutingStrategy(route.routingStrategy);
    const shouldSync = (
      currentStrategy === DEFAULT_ROUTE_ROUTING_STRATEGY
      || currentStrategy === input.targetStrategy
      || (previousStrategy !== null && currentStrategy === previousStrategy)
    );
    if (!shouldSync || currentStrategy === input.targetStrategy) continue;
    updatableRouteIds.push(route.id);
  }

  if (updatableRouteIds.length === 0) return [];

  await input.client.update(schema.tokenRoutes).set({
    routingStrategy: input.targetStrategy,
    updatedAt: new Date().toISOString(),
  }).where(inArray(schema.tokenRoutes.id, updatableRouteIds)).run();

  return updatableRouteIds;
}

/** 清除依赖任一指定来源路由的显式群组决策快照。 */
export async function clearDependentExplicitGroupSnapshotsBySourceRouteIds(
  sourceRouteIds: number[],
  client: DbClient = db,
): Promise<void> {
  const normalizedSourceRouteIds = Array.from(new Set(
    sourceRouteIds.filter((routeId): routeId is number => Number.isFinite(routeId) && routeId > 0),
  ));
  if (normalizedSourceRouteIds.length === 0) return;

  const rows = await client.select({ groupRouteId: schema.routeGroupSources.groupRouteId })
    .from(schema.routeGroupSources)
    .where(inArray(schema.routeGroupSources.sourceRouteId, normalizedSourceRouteIds))
    .all();
  const dependentRouteIdSet = new Set<number>();
  for (const row of rows) {
    const routeId = Number(row.groupRouteId);
    if (Number.isFinite(routeId) && routeId > 0) dependentRouteIdSet.add(routeId);
  }
  const dependentRouteIds = Array.from(dependentRouteIdSet);
  if (dependentRouteIds.length === 0) return;
  await clearRouteDecisionSnapshots(dependentRouteIds, client);
}

/** 获取账号首选的可用令牌，必要时回退到其他就绪令牌。 */
export async function getDefaultTokenId(
  accountId: number,
  client: DbClient = db,
): Promise<number | null> {
  const token = await client.select().from(schema.accountTokens)
    .where(and(
      eq(schema.accountTokens.accountId, accountId),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.isDefault, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
    ))
    .get();
  return isUsableAccountToken(token ?? null) ? token!.id : null;
}

function canonicalModelAlias(modelName: string): string {
  const normalized = modelName.trim().toLowerCase();
  if (!normalized) return '';
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return normalized.slice(slashIndex + 1);
  }
  return normalized;
}

function isModelAliasEquivalent(left: string, right: string): boolean {
  const a = canonicalModelAlias(left);
  const b = canonicalModelAlias(right);
  return !!a && !!b && a === b;
}

/** 检查令牌当前是否提供指定模型或等价模型别名。 */
export async function tokenSupportsModel(
  tokenId: number,
  modelName: string,
  client: DbClient = db,
): Promise<boolean> {
  const rows = await client.select().from(schema.tokenModelAvailability)
    .where(and(
      eq(schema.tokenModelAvailability.tokenId, tokenId),
      eq(schema.tokenModelAvailability.available, true),
    ))
    .all();
  return rows.some((row) => {
    const availableModelName = row.modelName?.trim();
    if (!availableModelName) return false;
    return availableModelName === modelName || isModelAliasEquivalent(availableModelName, modelName);
  });
}

/** 检查令牌是否存在且属于指定账号。 */
export async function checkTokenBelongsToAccount(
  tokenId: number,
  accountId: number,
  client: DbClient = db,
): Promise<boolean> {
  const row = await client.select().from(schema.accountTokens)
    .where(and(
      eq(schema.accountTokens.id, tokenId),
      eq(schema.accountTokens.accountId, accountId),
    ))
    .get();
  return isUsableAccountToken(row ?? null);
}

async function getPatternTokenCandidates(
  modelPattern: string,
  client: DbClient,
): Promise<Array<{ tokenId: number; accountId: number; sourceModel: string }>> {
  const rows = await client.select().from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.tokenModelAvailability.available, true),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
    ))
    .all();

  const result: Array<{ tokenId: number; accountId: number; sourceModel: string }> = [];
  for (const row of rows) {
    if (!isUsableAccountToken(row.account_tokens)) continue;
    const modelName = row.token_model_availability.modelName?.trim();
    if (!modelName || !matchesModelPattern(modelName, modelPattern)) continue;
    result.push({
      tokenId: row.account_tokens.id,
      accountId: row.accounts.id,
      sourceModel: modelName,
    });
  }
  return result;
}

async function getMatchedExactRouteChannelCandidates(
  modelPattern: string,
  client: DbClient,
): Promise<Array<{
  tokenId: number | null;
  accountId: number;
  sourceModel: string;
  priority: number;
  weight: number;
  enabled: boolean;
  manualOverride: boolean;
}>> {
  const matchedRoutes = (await client.select().from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.enabled, true))
    .all())
    .filter((route) => (
      isExactModelPattern(route.modelPattern)
      && matchesModelPattern(route.modelPattern, modelPattern)
    ));
  if (matchedRoutes.length === 0) return [];

  const routeMap = new Map<number, typeof schema.tokenRoutes.$inferSelect>();
  for (const route of matchedRoutes) {
    routeMap.set(route.id, route);
  }
  const channels = await client.select().from(schema.routeChannels)
    .where(inArray(schema.routeChannels.routeId, matchedRoutes.map((route) => route.id)))
    .all();

  return channels.map((channel) => ({
    tokenId: channel.tokenId ?? null,
    accountId: channel.accountId,
    sourceModel: (channel.sourceModel || routeMap.get(channel.routeId)?.modelPattern || '').trim(),
    priority: channel.priority ?? 0,
    weight: channel.weight ?? 10,
    enabled: !!channel.enabled,
    manualOverride: !!channel.manualOverride,
  })).filter((candidate) => candidate.sourceModel.length > 0);
}

async function populateRouteChannelsByModelPattern(
  routeId: number,
  modelPattern: string,
  client: DbClient,
): Promise<number> {
  const routeCandidates = await getMatchedExactRouteChannelCandidates(modelPattern, client);
  const availabilityCandidates = (await getPatternTokenCandidates(modelPattern, client))
    .map((candidate) => ({
      tokenId: candidate.tokenId,
      accountId: candidate.accountId,
      sourceModel: candidate.sourceModel,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }));
  const candidates = [...routeCandidates, ...availabilityCandidates];
  if (candidates.length === 0) return 0;

  const existingChannels = await client.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.routeId, routeId))
    .all();
  const existingPairs = new Set(
    existingChannels.map((channel) => {
      const tokenId = typeof channel.tokenId === 'number' && Number.isFinite(channel.tokenId)
        ? channel.tokenId
        : 0;
      const sourceModel = (channel.sourceModel || '').trim().toLowerCase();
      return `${channel.accountId}::${tokenId}::${sourceModel}`;
    }),
  );

  let created = 0;
  for (const candidate of candidates) {
    const tokenId = typeof candidate.tokenId === 'number' && Number.isFinite(candidate.tokenId)
      ? candidate.tokenId
      : 0;
    const pairKey = `${candidate.accountId}::${tokenId}::${candidate.sourceModel.trim().toLowerCase()}`;
    if (existingPairs.has(pairKey)) continue;
    await client.insert(schema.routeChannels).values({
      routeId,
      accountId: candidate.accountId,
      tokenId: candidate.tokenId,
      sourceModel: candidate.sourceModel,
      priority: candidate.priority,
      weight: candidate.weight,
      enabled: candidate.enabled,
      manualOverride: candidate.manualOverride,
    }).run();
    existingPairs.add(pairKey);
    created += 1;
  }
  return created;
}

async function rebuildAutomaticRouteChannelsByModelPattern(
  routeId: number,
  modelPattern: string,
  client: DbClient,
): Promise<void> {
  const removableChannels = await client.select().from(schema.routeChannels)
    .where(and(
      eq(schema.routeChannels.routeId, routeId),
      eq(schema.routeChannels.manualOverride, false),
    ))
    .all();
  for (const channel of removableChannels) {
    await client.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
  }
  await populateRouteChannelsByModelPattern(routeId, modelPattern, client);
}

function throwValidation(message: string): never {
  throw new RouteConfigurationMutationError(400, message);
}

/** 在共享路由投影互斥域中原子创建一条手工路由。 */
export async function createManualTokenRoute(body: TokenRouteCreatePayload): Promise<RouteRow> {
  return runRouteProjectionExclusive(async () => {
    const route = await db.transaction(async (tx: DbClient) => {
      const routeMode = normalizeRouteMode(body.routeMode);
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      const sourceRouteIds = normalizeSourceRouteIdsInput(body.sourceRouteIds);
      const routingStrategy = normalizeRouteRoutingStrategy(body.routingStrategy);
      const modelPattern = routeMode === 'explicit_group'
        ? displayName
        : (typeof body.modelPattern === 'string' ? body.modelPattern.trim() : '');

      if (routeMode === 'explicit_group') {
        if (!displayName) throwValidation('显式群组必须填写对外模型名');
        const validation = await validateExplicitGroupSourceRoutes(sourceRouteIds, undefined, tx);
        if (!validation.ok) throwValidation(validation.message);
      } else if (!modelPattern) {
        throwValidation('模型匹配不能为空');
      }

      const aliasNameConflict = await findSiteModelAliasRouteNameConflict(
        { modelPattern, displayName },
        tx,
      );
      if (aliasNameConflict) {
        throw new RouteConfigurationMutationError(
          409,
          aliasNameConflict.message,
          aliasNameConflict.code,
        );
      }

      const insertedRoute = await tx.insert(schema.tokenRoutes).values({
        modelPattern,
        displayName: displayName || body.displayName,
        displayIcon: body.displayIcon,
        routeMode,
        modelMapping: body.modelMapping,
        routingStrategy,
        enabled: body.enabled ?? true,
      }).run();
      const routeId = requireInsertedRowId(insertedRoute, '创建路由失败');

      if (routeMode === 'explicit_group') {
        await replaceRouteSourceRouteIds(routeId, sourceRouteIds, tx);
        const syncedRouteIds = await syncExplicitGroupSourceRouteStrategies({
          groupRouteId: routeId,
          sourceRouteIds,
          targetStrategy: routingStrategy,
          client: tx,
        });
        if (syncedRouteIds.length > 0) {
          await clearRouteDecisionSnapshots(syncedRouteIds, tx);
          await clearDependentExplicitGroupSnapshotsBySourceRouteIds(syncedRouteIds, tx);
        }
      } else {
        await populateRouteChannelsByModelPattern(routeId, modelPattern, tx);
      }

      const created = await getRouteWithSources(routeId, tx);
      if (!created) throw new Error('创建路由失败');
      return created;
    });

    invalidateTokenRouterCache();
    return route;
  });
}

/** 在共享路由投影互斥域中原子更新一条手工路由。 */
export async function updateManualTokenRoute(
  routeId: number,
  body: TokenRouteUpdatePayload,
): Promise<RouteRow> {
  return runRouteProjectionExclusive(async () => {
    const route = await db.transaction(async (tx: DbClient) => {
      const existingRoute = await getRouteWithSources(routeId, tx);
      if (!existingRoute) {
        throw new RouteConfigurationMutationError(404, '路由不存在');
      }
      if (isManagedSiteAliasRoute(existingRoute)) {
        throw new RouteConfigurationMutationError(
          409,
          '站点模型别名路由由系统维护，请在站点设置中修改',
        );
      }

      const routeMode = normalizeRouteMode(body.routeMode ?? existingRoute.routeMode);
      if (routeMode !== existingRoute.routeMode) {
        throwValidation('暂不支持在不同群组模式之间直接切换');
      }

      const updates: Record<string, unknown> = {};
      let nextModelPattern = existingRoute.modelPattern;
      let nextDisplayName = existingRoute.displayName ?? '';
      let nextSourceRouteIds = existingRoute.sourceRouteIds;
      const previousRoutingStrategy = normalizeRouteRoutingStrategy(existingRoute.routingStrategy);
      let nextRoutingStrategy = previousRoutingStrategy;

      if (body.displayName !== undefined) {
        nextDisplayName = String(body.displayName || '').trim();
        updates.displayName = nextDisplayName || null;
      }
      if (body.displayIcon !== undefined) updates.displayIcon = body.displayIcon;
      if (routeMode === 'explicit_group') {
        nextModelPattern = nextDisplayName;
        updates.modelPattern = nextModelPattern;
        if (body.sourceRouteIds !== undefined) {
          nextSourceRouteIds = normalizeSourceRouteIdsInput(body.sourceRouteIds);
        }
        if (!nextDisplayName) throwValidation('显式群组必须填写对外模型名');
        const validation = await validateExplicitGroupSourceRoutes(
          nextSourceRouteIds,
          routeId,
          tx,
        );
        if (!validation.ok) throwValidation(validation.message);
      } else if (body.modelPattern !== undefined) {
        nextModelPattern = String(body.modelPattern);
        updates.modelPattern = nextModelPattern;
      }
      if (body.modelMapping !== undefined) updates.modelMapping = body.modelMapping;
      if (body.routingStrategy !== undefined) {
        nextRoutingStrategy = normalizeRouteRoutingStrategy(body.routingStrategy);
        updates.routingStrategy = nextRoutingStrategy;
      }
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (body.routeMode !== undefined) updates.routeMode = routeMode;
      updates.updatedAt = new Date().toISOString();

      const aliasNameConflict = await findSiteModelAliasRouteNameConflict({
        modelPattern: nextModelPattern,
        displayName: nextDisplayName,
      }, tx);
      if (aliasNameConflict) {
        throw new RouteConfigurationMutationError(
          409,
          aliasNameConflict.message,
          aliasNameConflict.code,
        );
      }

      await tx.update(schema.tokenRoutes)
        .set(updates)
        .where(eq(schema.tokenRoutes.id, routeId))
        .run();
      if (routeMode === 'explicit_group' && body.sourceRouteIds !== undefined) {
        await replaceRouteSourceRouteIds(routeId, nextSourceRouteIds, tx);
      }

      const shouldSyncExplicitGroupSources = (
        routeMode === 'explicit_group'
        && (body.routingStrategy !== undefined || body.sourceRouteIds !== undefined)
      );
      let syncedSourceRouteIds: number[] = [];
      if (shouldSyncExplicitGroupSources) {
        syncedSourceRouteIds = await syncExplicitGroupSourceRouteStrategies({
          groupRouteId: routeId,
          sourceRouteIds: nextSourceRouteIds,
          targetStrategy: nextRoutingStrategy,
          previousStrategy: previousRoutingStrategy,
          client: tx,
        });
      }

      const modelPatternChanged = nextModelPattern !== existingRoute.modelPattern;
      const routeBehaviorChanged = modelPatternChanged
        || (routeMode === 'explicit_group' && body.sourceRouteIds !== undefined)
        || body.modelMapping !== undefined
        || body.routingStrategy !== undefined
        || body.enabled !== undefined;
      if (routeMode === 'pattern' && modelPatternChanged) {
        await rebuildAutomaticRouteChannelsByModelPattern(routeId, nextModelPattern, tx);
      }
      if (routeBehaviorChanged) {
        await clearRouteDecisionSnapshot(routeId, tx);
        await clearDependentExplicitGroupSnapshotsBySourceRouteIds([routeId], tx);
      }
      if (syncedSourceRouteIds.length > 0) {
        await clearRouteDecisionSnapshots(syncedSourceRouteIds, tx);
        await clearDependentExplicitGroupSnapshotsBySourceRouteIds(syncedSourceRouteIds, tx);
      }

      const updated = await getRouteWithSources(routeId, tx);
      if (!updated) throw new Error('更新路由失败');
      return updated;
    });

    invalidateTokenRouterCache();
    return route;
  });
}

/** 删除一条手工路由，并清除引用它的显式群组快照。 */
export async function deleteManualTokenRoute(routeId: number): Promise<{ success: true }> {
  return runRouteProjectionExclusive(async () => {
    await db.transaction(async (tx: DbClient) => {
      const route = await getRouteWithSources(routeId, tx);
      if (!route) return;
      if (isManagedSiteAliasRoute(route)) {
        throw new RouteConfigurationMutationError(
          409,
          '站点模型别名路由由系统维护，请在站点设置中修改',
        );
      }

      await clearDependentExplicitGroupSnapshotsBySourceRouteIds([routeId], tx);
      await tx.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).run();
    });

    invalidateTokenRouterCache();
    return { success: true };
  });
}

/** 在一次协调写入中批量启用或停用手工路由。 */
export async function setManualTokenRoutesEnabled(
  routeIds: number[],
  enabled: boolean,
): Promise<{ success: true; updatedCount: number }> {
  return runRouteProjectionExclusive(async () => {
    const updatedCount = await db.transaction(async (tx: DbClient) => {
      const managedAliasRoute = await tx.select({ id: schema.tokenRoutes.id })
        .from(schema.tokenRoutes)
        .where(and(
          inArray(schema.tokenRoutes.id, routeIds),
          eq(schema.tokenRoutes.routeKind, 'site_alias'),
        ))
        .get();
      if (managedAliasRoute) {
        throw new RouteConfigurationMutationError(
          409,
          '批量操作包含系统维护的站点模型别名路由',
        );
      }

      const updateResult = await tx.update(schema.tokenRoutes)
        .set({ enabled, updatedAt: new Date().toISOString() })
        .where(inArray(schema.tokenRoutes.id, routeIds))
        .run();

      await clearRouteDecisionSnapshots(routeIds, tx);
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds(routeIds, tx);
      return Number(updateResult?.changes || 0);
    });

    invalidateTokenRouterCache();
    return { success: true, updatedCount };
  });
}

/** 批量添加手工通道，并保留逐项部分成功的响应语义。 */
export async function addManualRouteChannels(
  routeId: number,
  body: RouteChannelBatchCreatePayload,
): Promise<{ success: true; created: number; skipped: number; errors: string[] }> {
  return runRouteProjectionExclusive(async () => {
    const route = await getRouteWithSources(routeId);
    if (!route) {
      throw new RouteConfigurationMutationError(404, '路由不存在');
    }
    if (isExplicitGroupRoute(route)) {
      throw new RouteConfigurationMutationError(400, '显式群组不支持直接维护通道');
    }
    if (isManagedSiteAliasRoute(route)) {
      throw new RouteConfigurationMutationError(
        409,
        '站点模型别名路由由系统维护，不能直接添加通道',
      );
    }

    const existingChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, routeId))
      .all();
    const existingPairs = new Set<string>(
      existingChannels.map((channel) => {
        const tokenId = typeof channel.tokenId === 'number' && Number.isFinite(channel.tokenId)
          ? channel.tokenId
          : 0;
        const sourceModel = (channel.sourceModel || '').trim().toLowerCase();
        return `${channel.accountId}::${tokenId}::${sourceModel}`;
      }),
    );

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const item of body.channels) {
      const sourceModel = typeof item.sourceModel === 'string'
        ? item.sourceModel.trim()
        : (isExactModelPattern(route.modelPattern) ? route.modelPattern.trim() : '');
      const effectiveTokenId = item.tokenId ?? await getDefaultTokenId(item.accountId);

      if (item.tokenId && !await checkTokenBelongsToAccount(item.tokenId, item.accountId)) {
        errors.push(`令牌 ${item.tokenId} 不属于账号 ${item.accountId}`);
        continue;
      }

      const tokenIdForKey = typeof effectiveTokenId === 'number' && Number.isFinite(effectiveTokenId)
        ? effectiveTokenId
        : 0;
      const pairKey = `${item.accountId}::${tokenIdForKey}::${sourceModel.toLowerCase()}`;
      if (existingPairs.has(pairKey)) {
        skipped += 1;
        continue;
      }

      try {
        await db.transaction(async (tx: DbClient) => {
          await tx.insert(schema.routeChannels).values({
            routeId,
            accountId: item.accountId,
            tokenId: effectiveTokenId,
            sourceModel: sourceModel || null,
            priority: 0,
            weight: 10,
            manualOverride: true,
          }).run();
          await clearRouteDecisionSnapshot(routeId, tx);
          await clearDependentExplicitGroupSnapshotsBySourceRouteIds([routeId], tx);
        });
        existingPairs.add(pairKey);
        created += 1;
      } catch (error) {
        const fallback = `添加通道失败: accountId=${item.accountId}`;
        errors.push(error instanceof Error && error.message ? error.message : fallback);
      }
    }

    if (created > 0) invalidateTokenRouterCache();
    return { success: true, created, skipped, errors };
  });
}

/** 为一条手工路由添加单个通道。 */
export async function addManualRouteChannel(
  routeId: number,
  body: RouteChannelCreatePayload,
): Promise<typeof schema.routeChannels.$inferSelect> {
  return runRouteProjectionExclusive(async () => {
    const channel = await db.transaction(async (tx: DbClient) => {
      const route = await getRouteWithSources(routeId, tx);
      if (!route) {
        throw new RouteConfigurationMutationError(404, '路由不存在');
      }
      if (isManagedSiteAliasRoute(route)) {
        throw new RouteConfigurationMutationError(
          409,
          '站点模型别名路由由系统维护，不能直接添加通道',
        );
      }
      if (isExplicitGroupRoute(route)) {
        throw new RouteConfigurationMutationError(400, '显式群组不支持直接维护通道');
      }

      const sourceModel = typeof body.sourceModel === 'string'
        ? body.sourceModel.trim()
        : (isExactModelPattern(route.modelPattern) ? route.modelPattern.trim() : '');
      const effectiveTokenId = body.tokenId ?? await getDefaultTokenId(body.accountId, tx);

      if (body.tokenId && !await checkTokenBelongsToAccount(body.tokenId, body.accountId, tx)) {
        throw new RouteConfigurationMutationError(400, '令牌不存在或不属于当前账号');
      }
      if (
        isExactModelPattern(route.modelPattern)
        && effectiveTokenId
        && !await tokenSupportsModel(effectiveTokenId, route.modelPattern, tx)
      ) {
        throw new RouteConfigurationMutationError(400, '该令牌不支持当前模型');
      }

      const duplicate = (await tx.select().from(schema.routeChannels)
        .where(eq(schema.routeChannels.routeId, routeId))
        .all())
        .some((existingChannel) => (
          existingChannel.accountId === body.accountId
          && (existingChannel.tokenId ?? null) === (body.tokenId ?? null)
          && (existingChannel.sourceModel || '').trim().toLowerCase() === sourceModel.toLowerCase()
        ));
      if (duplicate) {
        throw new RouteConfigurationMutationError(400, '该来源模型的通道已存在');
      }

      const insertedChannel = await tx.insert(schema.routeChannels).values({
        routeId,
        accountId: body.accountId,
        tokenId: body.tokenId,
        sourceModel: sourceModel || null,
        priority: body.priority ?? 0,
        weight: body.weight ?? 10,
      }).run();
      const channelId = requireInsertedRowId(insertedChannel, '创建通道失败');
      const created = await tx.select().from(schema.routeChannels)
        .where(eq(schema.routeChannels.id, channelId))
        .get();
      if (!created) throw new RouteConfigurationMutationError(500, '创建通道失败');

      await clearRouteDecisionSnapshot(routeId, tx);
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds([routeId], tx);
      return created;
    });

    invalidateTokenRouterCache();
    return channel;
  });
}

/** 批量更新通道优先级，并将所选通道标记为手工覆盖。 */
export async function updateManualRouteChannelPriorities(
  updates: RouteChannelPriorityUpdate[],
): Promise<{ success: true; channels: Array<typeof schema.routeChannels.$inferSelect> }> {
  return runRouteProjectionExclusive(async () => {
    const channels = await db.transaction(async (tx: DbClient) => {
      const channelIds = Array.from(new Set(updates.map((update) => update.id)));
      const existingChannels = await tx.select().from(schema.routeChannels)
        .where(inArray(schema.routeChannels.id, channelIds))
        .all();
      if (existingChannels.length !== channelIds.length) {
        const existingIds = new Set(existingChannels.map((channel) => channel.id));
        const missingId = channelIds.find((id) => !existingIds.has(id));
        throw new RouteConfigurationMutationError(404, `通道不存在: ${missingId}`);
      }

      const affectedRouteIds = Array.from(new Set<number>(
        existingChannels.map((channel: typeof schema.routeChannels.$inferSelect) => channel.routeId),
      ));
      const managedAliasRoute = await tx.select({ id: schema.tokenRoutes.id })
        .from(schema.tokenRoutes)
        .where(and(
          inArray(schema.tokenRoutes.id, affectedRouteIds),
          eq(schema.tokenRoutes.routeKind, 'site_alias'),
        ))
        .get();
      if (managedAliasRoute) {
        throw new RouteConfigurationMutationError(
          409,
          '批量操作包含系统维护的站点模型别名通道',
        );
      }

      for (const update of updates) {
        await tx.update(schema.routeChannels).set({
          priority: update.priority,
          manualOverride: true,
        }).where(eq(schema.routeChannels.id, update.id)).run();
      }

      const updatedChannels = await tx.select().from(schema.routeChannels)
        .where(inArray(schema.routeChannels.id, channelIds))
        .all();
      await clearRouteDecisionSnapshots(affectedRouteIds, tx);
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds(affectedRouteIds, tx);
      return updatedChannels;
    });

    invalidateTokenRouterCache();
    return { success: true, channels };
  });
}

/** 更新手工路由所属的单个通道。 */
export async function updateManualRouteChannel(
  channelId: number,
  body: RouteChannelUpdatePayload,
): Promise<typeof schema.routeChannels.$inferSelect> {
  return runRouteProjectionExclusive(async () => {
    const channel = await db.transaction(async (tx: DbClient) => {
      const existingChannel = await tx.select().from(schema.routeChannels)
        .where(eq(schema.routeChannels.id, channelId))
        .get();
      if (!existingChannel) {
        throw new RouteConfigurationMutationError(404, '通道不存在');
      }

      const route = await tx.select().from(schema.tokenRoutes)
        .where(eq(schema.tokenRoutes.id, existingChannel.routeId))
        .get();
      if (!route) {
        throw new RouteConfigurationMutationError(404, '路由不存在');
      }
      if (isManagedSiteAliasRoute(route)) {
        throw new RouteConfigurationMutationError(
          409,
          '站点模型别名路由由系统维护，不能直接修改通道',
        );
      }

      if (body.tokenId !== undefined && body.tokenId !== null) {
        const tokenId = Number(body.tokenId);
        if (!Number.isFinite(tokenId) || !await checkTokenBelongsToAccount(tokenId, existingChannel.accountId, tx)) {
          throw new RouteConfigurationMutationError(400, '令牌不存在或不属于通道账号');
        }
      }

      const nextTokenId = body.tokenId === undefined
        ? (existingChannel.tokenId ?? await getDefaultTokenId(existingChannel.accountId, tx))
        : (body.tokenId === null
          ? await getDefaultTokenId(existingChannel.accountId, tx)
          : Number(body.tokenId));
      if (
        isExactModelPattern(route.modelPattern)
        && nextTokenId
        && !await tokenSupportsModel(nextTokenId, route.modelPattern, tx)
      ) {
        throw new RouteConfigurationMutationError(400, '该令牌不支持当前模型');
      }

      const channelUpdates: Record<string, unknown> = { manualOverride: true };
      if (body.sourceModel !== undefined) {
        channelUpdates.sourceModel = body.sourceModel === null
          ? null
          : (String(body.sourceModel).trim() || null);
      }
      if (body.priority !== undefined) channelUpdates.priority = body.priority;
      if (body.weight !== undefined) channelUpdates.weight = body.weight;
      if (body.enabled !== undefined) channelUpdates.enabled = body.enabled;
      if (body.tokenId !== undefined) channelUpdates.tokenId = nextTokenId;

      await tx.update(schema.routeChannels)
        .set(channelUpdates)
        .where(eq(schema.routeChannels.id, channelId))
        .run();
      await clearRouteDecisionSnapshot(existingChannel.routeId, tx);
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds([existingChannel.routeId], tx);

      const updated = await tx.select().from(schema.routeChannels)
        .where(eq(schema.routeChannels.id, channelId))
        .get();
      if (!updated) throw new Error('更新通道失败');
      return updated;
    });

    invalidateTokenRouterCache();
    return channel;
  });
}

/** 删除单个通道，但拒绝修改系统维护的别名路由。 */
export async function deleteManualRouteChannel(channelId: number): Promise<{ success: true }> {
  return runRouteProjectionExclusive(async () => {
    await db.transaction(async (tx: DbClient) => {
      const channel = await tx.select().from(schema.routeChannels)
        .where(eq(schema.routeChannels.id, channelId))
        .get();
      if (channel) {
        const route = await tx.select({ routeKind: schema.tokenRoutes.routeKind })
          .from(schema.tokenRoutes)
          .where(eq(schema.tokenRoutes.id, channel.routeId))
          .get();
        if (route?.routeKind === 'site_alias') {
          throw new RouteConfigurationMutationError(
            409,
            '站点模型别名路由由系统维护，不能直接删除通道',
          );
        }
      }

      await tx.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).run();
      if (channel) {
        await clearRouteDecisionSnapshot(channel.routeId, tx);
        await clearDependentExplicitGroupSnapshotsBySourceRouteIds([channel.routeId], tx);
      }
    });

    invalidateTokenRouterCache();
    return { success: true };
  });
}
