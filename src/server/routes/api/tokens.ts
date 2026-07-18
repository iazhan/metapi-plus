import { FastifyInstance, type FastifyReply } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { db, schema } from '../../db/index.js';
import * as routeRefreshWorkflow from '../../services/routeRefreshWorkflow.js';
import { matchesModelPattern, tokenRouter } from '../../services/tokenRouter.js';
import { appendBackgroundTaskLog, startBackgroundTask } from '../../services/backgroundTaskService.js';
import {
  parseRouteDecisionSnapshot,
  saveRouteDecisionSnapshots,
} from '../../services/routeDecisionSnapshotStore.js';
import { clearRouteCooldown } from '../../services/routeCooldownService.js';
import {
  addManualRouteChannel,
  addManualRouteChannels,
  createManualTokenRoute,
  deleteManualRouteChannel,
  deleteManualTokenRoute,
  getRouteWithSources,
  isExactModelPattern,
  isExplicitGroupRoute,
  isManagedSiteAliasRoute,
  listRoutesWithSources,
  RouteConfigurationMutationError,
  setManualTokenRoutesEnabled,
  updateManualRouteChannel,
  updateManualRouteChannelPriorities,
  updateManualTokenRoute,
  type RouteRow,
} from '../../services/routeConfigurationService.js';
import {
  refreshAllRouteDecisionSnapshots,
  ROUTE_DECISION_REFRESH_DEDUPE_KEY,
  ROUTE_DECISION_REFRESH_TASK_TYPE,
} from '../../services/routeDecisionRefreshService.js';
import {
  parseRouteChannelBatchCreatePayload,
  parseRouteChannelCreatePayload,
  parseRouteChannelUpdatePayload,
  parseRouteRebuildPayload,
  parseTokenRouteBatchPayload,
  parseTokenRouteCreatePayload,
  parseTokenRouteUpdatePayload,
} from '../../contracts/tokenRoutePayloads.js';

function createTokenRouteReadLimiter(keyPrefix: string, points = 60) {
  return new RateLimiterMemory({
    keyPrefix,
    points,
    duration: 60,
  });
}

let routeSummaryReadLimiter = createTokenRouteReadLimiter('token-routes-summary-read');
let routeListReadLimiter = createTokenRouteReadLimiter('token-routes-list-read');

export function resetTokenRouteReadLimitersForTests(options: {
  summaryPoints?: number;
  listPoints?: number;
} = {}): void {
  routeSummaryReadLimiter = createTokenRouteReadLimiter('token-routes-summary-read', options.summaryPoints ?? 60);
  routeListReadLimiter = createTokenRouteReadLimiter('token-routes-list-read', options.listPoints ?? 60);
}

function sendTokenRouteRateLimit(reply: FastifyReply, error: unknown): void {
  const retryState = error instanceof RateLimiterRes ? error : null;
  const retryAfterSec = Math.max(1, Math.ceil((retryState?.msBeforeNext ?? 60_000) / 1000));
  reply.code(429).header('retry-after', String(retryAfterSec))
    .send({ success: false, message: '请求过于频繁，请稍后再试' });
}

function sendRouteConfigurationMutationError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply | null {
  if (!(error instanceof RouteConfigurationMutationError)) return null;
  return reply.code(error.statusCode).send({
    success: false,
    ...(error.code ? { code: error.code } : {}),
    message: error.message,
  });
}

type BatchChannelPriorityUpdate = {
  id: number;
  priority: number;
};

type BatchRouteDecisionModels = {
  models: string[];
  refreshPricingCatalog?: boolean;
  persistSnapshots?: boolean;
};

type BatchRouteDecisionRouteModels = {
  items: Array<{
    routeId: number;
    model: string;
  }>;
  refreshPricingCatalog?: boolean;
  persistSnapshots?: boolean;
};

type BatchRouteWideDecisionRouteIds = {
  routeIds: number[];
  refreshPricingCatalog?: boolean;
  persistSnapshots?: boolean;
};

function parseBatchChannelUpdates(input: unknown): { ok: true; updates: BatchChannelPriorityUpdate[] } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const updates = (input as { updates?: unknown }).updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: false, message: 'updates 必须是非空数组' };
  }

  const normalized: BatchChannelPriorityUpdate[] = [];
  for (let index = 0; index < updates.length; index += 1) {
    const item = updates[index];
    if (!item || typeof item !== 'object') {
      return { ok: false, message: `updates[${index}] 必须是对象` };
    }

    const { id, priority } = item as { id?: unknown; priority?: unknown };
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      return { ok: false, message: `updates[${index}].id 必须是有限数字` };
    }
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      return { ok: false, message: `updates[${index}].priority 必须是有限数字` };
    }

    const normalizedId = Math.trunc(id);
    if (normalizedId <= 0) {
      return { ok: false, message: `updates[${index}].id 必须大于 0` };
    }

    normalized.push({
      id: normalizedId,
      priority: Math.max(0, Math.trunc(priority)),
    });
  }

  return { ok: true, updates: normalized };
}

function parseBatchRouteDecisionModels(
  input: unknown,
): { ok: true; models: string[]; refreshPricingCatalog: boolean; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const models = (input as BatchRouteDecisionModels).models;
  if (!Array.isArray(models) || models.length === 0) {
    return { ok: false, message: 'models 必须是非空数组' };
  }

  const dedupe = new Set<string>();
  const normalized: string[] = [];
  for (const raw of models) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || dedupe.has(trimmed)) continue;
    dedupe.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= 500) break;
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'models 中没有有效模型名称' };
  }

  return {
    ok: true,
    models: normalized,
    refreshPricingCatalog: (input as { refreshPricingCatalog?: unknown }).refreshPricingCatalog === true,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

function parseBatchRouteDecisionRouteModels(
  input: unknown,
): { ok: true; items: Array<{ routeId: number; model: string }>; refreshPricingCatalog: boolean; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const items = (input as BatchRouteDecisionRouteModels).items;
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'items 必须是非空数组' };
  }

  const dedupe = new Set<string>();
  const normalized: Array<{ routeId: number; model: string }> = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const routeIdRaw = (item as { routeId?: unknown }).routeId;
    const modelRaw = (item as { model?: unknown }).model;
    if (typeof routeIdRaw !== 'number' || !Number.isFinite(routeIdRaw)) continue;
    if (typeof modelRaw !== 'string') continue;

    const routeId = Math.trunc(routeIdRaw);
    const model = modelRaw.trim();
    if (routeId <= 0 || !model) continue;

    const key = `${routeId}::${model}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    normalized.push({ routeId, model });
    if (normalized.length >= 500) break;
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'items 中没有有效 routeId/model' };
  }

  return {
    ok: true,
    items: normalized,
    refreshPricingCatalog: (input as { refreshPricingCatalog?: unknown }).refreshPricingCatalog === true,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

function parseBatchRouteWideDecisionRouteIds(
  input: unknown,
): { ok: true; routeIds: number[]; refreshPricingCatalog: boolean; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const routeIds = (input as BatchRouteWideDecisionRouteIds).routeIds;
  if (!Array.isArray(routeIds) || routeIds.length === 0) {
    return { ok: false, message: 'routeIds 必须是非空数组' };
  }

  const dedupe = new Set<number>();
  const normalized: number[] = [];
  for (const raw of routeIds) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const routeId = Math.trunc(raw);
    if (routeId <= 0 || dedupe.has(routeId)) continue;
    dedupe.add(routeId);
    normalized.push(routeId);
    if (normalized.length >= 500) break;
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'routeIds 中没有有效 routeId' };
  }

  return {
    ok: true,
    routeIds: normalized,
    refreshPricingCatalog: (input as { refreshPricingCatalog?: unknown }).refreshPricingCatalog === true,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

type RouteChannelSummary = {
  channelCount: number;
  enabledChannelCount: number;
  siteNames: Set<string>;
};

async function fetchChannelsForRouteRows(
  routes: RouteRow[],
): Promise<Map<number, any[]>> {
  if (routes.length === 0) return new Map();

  const explicitSourceRouteIds = Array.from(new Set(routes
    .filter((route) => isExplicitGroupRoute(route))
    .flatMap((route) => route.sourceRouteIds)));
  const explicitSourceRoutes = explicitSourceRouteIds.length > 0
    ? (await db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      routeMode: schema.tokenRoutes.routeMode,
      enabled: schema.tokenRoutes.enabled,
    }).from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, explicitSourceRouteIds))
      .all())
    : [];
  const enabledExplicitSourceRouteIds = explicitSourceRoutes
    .filter((route) => route.enabled && !isExplicitGroupRoute(route) && isExactModelPattern(route.modelPattern))
    .map((route) => route.id);
  const actualRouteIds = Array.from(new Set([
    ...routes.filter((route) => !isExplicitGroupRoute(route)).map((route) => route.id),
    ...enabledExplicitSourceRouteIds,
  ]));
  if (actualRouteIds.length === 0) {
    return new Map(routes.map((route) => [route.id, []]));
  }

  const actualRouteById = new Map<number, { modelPattern: string; routeMode: string | null }>();
  for (const route of routes.filter((item) => !isExplicitGroupRoute(item))) {
    actualRouteById.set(route.id, { modelPattern: route.modelPattern, routeMode: route.routeMode ?? null });
  }
  for (const route of explicitSourceRoutes) {
    actualRouteById.set(route.id, { modelPattern: route.modelPattern, routeMode: route.routeMode ?? null });
  }

  const channelRows = await db.select().from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(inArray(schema.routeChannels.routeId, actualRouteIds))
    .all();

  const channelsByActualRouteId = new Map<number, any[]>();

  for (const row of channelRows) {
    const routeId = row.route_channels.routeId;
    const actualRoute = actualRouteById.get(routeId);
    const fallbackSourceModel = actualRoute && !isExplicitGroupRoute(actualRoute) && isExactModelPattern(actualRoute.modelPattern)
      ? actualRoute.modelPattern
      : null;
    const resolvedSourceModel = (row.route_channels.sourceModel || fallbackSourceModel || '').trim();
    if (!channelsByActualRouteId.has(routeId)) channelsByActualRouteId.set(routeId, []);
    channelsByActualRouteId.get(routeId)!.push({
      ...row.route_channels,
      sourceModel: resolvedSourceModel || null,
      account: row.accounts,
      site: row.sites,
      token: row.account_tokens
        ? {
          id: row.account_tokens.id,
          name: row.account_tokens.name,
          accountId: row.account_tokens.accountId,
          enabled: row.account_tokens.enabled,
          isDefault: row.account_tokens.isDefault,
        }
        : null,
    });
  }

  const channelsByRoute = new Map<number, any[]>();
  for (const route of routes) {
    if (isExplicitGroupRoute(route)) {
      channelsByRoute.set(route.id, route.sourceRouteIds.flatMap((sourceRouteId) => channelsByActualRouteId.get(sourceRouteId) || []));
      continue;
    }
    channelsByRoute.set(route.id, channelsByActualRouteId.get(route.id) || []);
  }

  return channelsByRoute;
}

async function fetchChannelsForRoutes(routeIds: number[]): Promise<Map<number, any[]>> {
  if (routeIds.length === 0) return new Map();
  return await fetchChannelsForRouteRows(await listRoutesWithSources()).then((channelsByRoute) => {
    const filtered = new Map<number, any[]>();
    for (const routeId of routeIds) {
      filtered.set(routeId, channelsByRoute.get(routeId) || []);
    }
    return filtered;
  });
}

async function buildRouteChannelSummaryMap(routes: RouteRow[]): Promise<Map<number, RouteChannelSummary>> {
  const channelsByRoute = await fetchChannelsForRouteRows(routes);
  const summaryByRoute = new Map<number, RouteChannelSummary>();
  for (const route of routes) {
    const channels = channelsByRoute.get(route.id) || [];
    const siteNames = new Set<string>();
    let enabledChannelCount = 0;
    for (const channel of channels) {
      if (channel.enabled) enabledChannelCount += 1;
      if (channel.site?.name) siteNames.add(channel.site.name);
    }
    summaryByRoute.set(route.id, {
      channelCount: channels.length,
      enabledChannelCount,
      siteNames,
    });
  }
  return summaryByRoute;
}

export async function tokensRoutes(app: FastifyInstance) {
  // List routes with basic info only (lightweight for selectors)
  app.get('/api/routes/lite', async () => {
    return (await listRoutesWithSources()).map((route) => ({
      id: route.id,
      modelPattern: route.modelPattern,
      displayName: route.displayName,
      displayIcon: route.displayIcon,
      routeMode: route.routeMode,
      routeKind: route.routeKind,
      sourceRouteIds: route.sourceRouteIds,
      routingStrategy: route.routingStrategy,
      enabled: route.enabled,
    }));
  });

  // Route summary (no channel details) for first-screen rendering
  app.get('/api/routes/summary', async (request, reply) => {
    try {
      await routeSummaryReadLimiter.consume(request.ip);
    } catch (error) {
      sendTokenRouteRateLimit(reply, error);
      return;
    }
    const routes = await listRoutesWithSources();
    if (routes.length === 0) return [];
    const aggByRoute = await buildRouteChannelSummaryMap(routes);

    return routes.map((route) => {
      const agg = aggByRoute.get(route.id);
      return {
        id: route.id,
        modelPattern: route.modelPattern,
        displayName: route.displayName ?? null,
        displayIcon: route.displayIcon ?? null,
        routeMode: route.routeMode,
        routeKind: route.routeKind ?? null,
        sourceRouteIds: route.sourceRouteIds,
        modelMapping: route.modelMapping ?? null,
        routingStrategy: route.routingStrategy ?? 'weighted',
        enabled: route.enabled,
        channelCount: agg?.channelCount ?? 0,
        enabledChannelCount: agg?.enabledChannelCount ?? 0,
        siteNames: agg ? Array.from(agg.siteNames) : [],
        decisionSnapshot: parseRouteDecisionSnapshot(route.decisionSnapshot),
        decisionRefreshedAt: route.decisionRefreshedAt ?? null,
      };
    });
  });

  // Get channels for a single route (on-demand loading)
  app.get<{ Params: { id: string } }>('/api/routes/:id/channels', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const route = await getRouteWithSources(routeId);
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    const channelsByRoute = await fetchChannelsForRouteRows([route]);
    return channelsByRoute.get(routeId) || [];
  });

  app.post<{ Params: { id: string } }>('/api/routes/:id/cooldown/clear', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const route = await getRouteWithSources(routeId);
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    if (isManagedSiteAliasRoute(route)) {
      return reply.code(409).send({ success: false, message: '站点模型别名路由由系统维护，不能直接清除冷却' });
    }
    const result = await clearRouteCooldown(routeId);
    return result;
  });

  // Batch add channels to a route
  app.post<{ Params: { id: string }; Body: unknown }>('/api/routes/:id/channels/batch', async (request, reply) => {
    const parsedBody = parseRouteChannelBatchCreatePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const routeId = parseInt(request.params.id, 10);
    try {
      return await addManualRouteChannels(routeId, parsedBody.data);
    } catch (error) {
      const errorReply = sendRouteConfigurationMutationError(reply, error);
      if (errorReply) return errorReply;
      throw error;
    }
  });

  // List all routes
  app.get('/api/routes', async (request, reply) => {
    try {
      await routeListReadLimiter.consume(request.ip);
    } catch (error) {
      sendTokenRouteRateLimit(reply, error);
      return;
    }
    const routes = await listRoutesWithSources();
    if (routes.length === 0) return [];

    const channelsByRoute = await fetchChannelsForRouteRows(routes);

    return routes.map((route) => ({
      ...route,
      decisionSnapshot: parseRouteDecisionSnapshot(route.decisionSnapshot),
      decisionRefreshedAt: route.decisionRefreshedAt ?? null,
      channels: channelsByRoute.get(route.id) || [],
    }));
  });

  app.get<{ Querystring: { model?: string } }>('/api/routes/decision', async (request, reply) => {
    const model = (request.query.model || '').trim();
    if (!model) {
      return reply.code(400).send({ success: false, message: 'model 不能为空' });
    }

    const decision = await tokenRouter.explainSelection(model);
    return { success: true, decision };
  });

  app.post<{ Body: BatchRouteDecisionModels }>('/api/routes/decision/batch', async (request, reply) => {
    const parsed = parseBatchRouteDecisionModels(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const decisions: Record<string, Awaited<ReturnType<typeof tokenRouter.explainSelection>>> = {};
    const routes = parsed.persistSnapshots
      ? await db.select({
        id: schema.tokenRoutes.id,
        modelPattern: schema.tokenRoutes.modelPattern,
      }).from(schema.tokenRoutes).all()
      : [];
    const refreshedKeys = parsed.refreshPricingCatalog ? new Set<string>() : undefined;
    for (const model of parsed.models) {
      if (parsed.refreshPricingCatalog) {
        await tokenRouter.refreshPricingReferenceCosts(model, { refreshedKeys });
      }
      decisions[model] = await tokenRouter.explainSelection(model);
    }

    if (parsed.persistSnapshots) {
      const snapshotWrites: Array<{ routeId: number; snapshot: unknown }> = [];
      for (const model of parsed.models) {
        const decision = decisions[model];
        for (const route of routes) {
          if (!isExactModelPattern(route.modelPattern)) continue;
          if (!matchesModelPattern(model, route.modelPattern)) continue;
          snapshotWrites.push({ routeId: route.id, snapshot: decision });
        }
      }
      await saveRouteDecisionSnapshots(snapshotWrites);
    }

    return { success: true, decisions };
  });

  app.post<{ Body: BatchRouteDecisionRouteModels }>('/api/routes/decision/by-route/batch', async (request, reply) => {
    const parsed = parseBatchRouteDecisionRouteModels(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const decisions: Record<string, Record<string, Awaited<ReturnType<typeof tokenRouter.explainSelectionForRoute>>>> = {};
    const refreshedKeys = parsed.refreshPricingCatalog ? new Set<string>() : undefined;
    for (const item of parsed.items) {
      const routeKey = String(item.routeId);
      if (!decisions[routeKey]) decisions[routeKey] = {};
      if (parsed.refreshPricingCatalog) {
        await tokenRouter.refreshPricingReferenceCostsForRoute(item.routeId, item.model, { refreshedKeys });
      }
      decisions[routeKey][item.model] = await tokenRouter.explainSelectionForRoute(item.routeId, item.model);
    }

    if (parsed.persistSnapshots) {
      await saveRouteDecisionSnapshots(parsed.items.map((item) => ({
        routeId: item.routeId,
        snapshot: decisions[String(item.routeId)]?.[item.model] ?? null,
      })));
    }

    return { success: true, decisions };
  });

  app.post<{ Body: BatchRouteWideDecisionRouteIds }>('/api/routes/decision/route-wide/batch', async (request, reply) => {
    const parsed = parseBatchRouteWideDecisionRouteIds(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const decisions: Record<string, Awaited<ReturnType<typeof tokenRouter.explainSelectionRouteWide>>> = {};
    const refreshedKeys = parsed.refreshPricingCatalog ? new Set<string>() : undefined;
    for (const routeId of parsed.routeIds) {
      if (parsed.refreshPricingCatalog) {
        await tokenRouter.refreshRouteWidePricingReferenceCosts(routeId, { refreshedKeys });
      }
      decisions[String(routeId)] = await tokenRouter.explainSelectionRouteWide(routeId);
    }

    if (parsed.persistSnapshots) {
      await saveRouteDecisionSnapshots(parsed.routeIds.map((routeId) => ({
        routeId,
        snapshot: decisions[String(routeId)] ?? null,
      })));
    }

    return { success: true, decisions };
  });

  app.post('/api/routes/decision/refresh', async (_request, reply) => {
    let taskId = '';
    const { task, reused } = startBackgroundTask(
      {
        type: ROUTE_DECISION_REFRESH_TASK_TYPE,
        title: '刷新路由选中概率',
        dedupeKey: ROUTE_DECISION_REFRESH_DEDUPE_KEY,
        successMessage: (currentTask) => {
          const result = currentTask.result as { exactModelCount?: number; wildcardRouteCount?: number } | null;
          const exactModelCount = result?.exactModelCount ?? 0;
          const wildcardRouteCount = result?.wildcardRouteCount ?? 0;
          return `路由选中概率刷新完成：精确模型 ${exactModelCount}，通配符路由 ${wildcardRouteCount}`;
        },
        failureMessage: (currentTask) => `路由选中概率刷新失败：${currentTask.error || 'unknown error'}`,
      },
      async () => {
        await Promise.resolve();
        return await refreshAllRouteDecisionSnapshots({
          refreshPricingCatalog: true,
          onProgress: (message) => {
            appendBackgroundTaskLog(taskId, message);
          },
        });
      },
    );
    taskId = task.id;

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '路由选中概率刷新任务执行中，可稍后返回查看'
        : '已开始后台刷新路由选中概率，可稍后返回查看',
    });
  });

  // Create a route
  app.post<{ Body: unknown }>('/api/routes', async (request, reply) => {
    const parsedBody = parseTokenRouteCreatePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    try {
      return await createManualTokenRoute(parsedBody.data);
    } catch (error) {
      const errorReply = sendRouteConfigurationMutationError(reply, error);
      if (errorReply) return errorReply;
      throw error;
    }
  });

  // Update a route
  app.put<{ Params: { id: string }; Body: unknown }>('/api/routes/:id', async (request, reply) => {
    const parsedBody = parseTokenRouteUpdatePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const routeId = Number.parseInt(request.params.id, 10);
    try {
      return await updateManualTokenRoute(routeId, parsedBody.data);
    } catch (error) {
      const errorReply = sendRouteConfigurationMutationError(reply, error);
      if (errorReply) return errorReply;
      throw error;
    }
  });

  // Delete a route
  app.delete<{ Params: { id: string } }>('/api/routes/:id', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    try {
      return await deleteManualTokenRoute(routeId);
    } catch (error) {
      const errorReply = sendRouteConfigurationMutationError(reply, error);
      if (errorReply) return errorReply;
      throw error;
    }
  });


  // Batch update routes (enable/disable)
  app.post<{ Body: unknown }>('/api/routes/batch', async (request, reply) => {
    const parsedBody = parseTokenRouteBatchPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }
    const body = parsedBody.data;
    const action = body.action;
    if (action !== 'enable' && action !== 'disable') {
      return reply.code(400).send({ success: false, message: 'action 必须是 enable 或 disable' });
    }
    const rawIds = body.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return reply.code(400).send({ success: false, message: 'ids 必须是非空数组' });
    }
    const dedupe = new Set<number>();
    const ids: number[] = [];
    for (const raw of rawIds) {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const id = Math.trunc(raw);
      if (id <= 0 || dedupe.has(id)) continue;
      dedupe.add(id);
      ids.push(id);
      if (ids.length >= 500) break;
    }
    if (ids.length === 0) {
      return reply.code(400).send({ success: false, message: 'ids 中没有有效的路由 ID' });
    }

    try {
      return await setManualTokenRoutesEnabled(ids, action === 'enable');
    } catch (error) {
      const errorReply = sendRouteConfigurationMutationError(reply, error);
      if (errorReply) return errorReply;
      throw error;
    }
  });
  // Add a channel to a route
  app.post<{ Params: { id: string }; Body: unknown }>('/api/routes/:id/channels', async (request, reply) => {
    const parsedBody = parseRouteChannelCreatePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const routeId = parseInt(request.params.id, 10);
    try {
      return await addManualRouteChannel(routeId, parsedBody.data);
    } catch (error) {
      const errorReply = sendRouteConfigurationMutationError(reply, error);
      if (errorReply) return errorReply;
      throw error;
    }
  });

  // Batch update channel priorities
  app.put<{ Body: { updates: Array<{ id: number; priority: number }> } }>('/api/channels/batch', async (request, reply) => {
    const parsed = parseBatchChannelUpdates(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    try {
      return await updateManualRouteChannelPriorities(parsed.updates);
    } catch (error) {
      const errorReply = sendRouteConfigurationMutationError(reply, error);
      if (errorReply) return errorReply;
      throw error;
    }
  });

  // Update a channel
  app.put<{ Params: { channelId: string }; Body: unknown }>('/api/channels/:channelId', async (request, reply) => {
    const parsedBody = parseRouteChannelUpdatePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const channelId = parseInt(request.params.channelId, 10);
    try {
      return await updateManualRouteChannel(channelId, parsedBody.data);
    } catch (error) {
      const errorReply = sendRouteConfigurationMutationError(reply, error);
      if (errorReply) return errorReply;
      throw error;
    }
  });

  // Delete a channel
  app.delete<{ Params: { channelId: string } }>('/api/channels/:channelId', async (request, reply) => {
    const channelId = parseInt(request.params.channelId, 10);
    try {
      return await deleteManualRouteChannel(channelId);
    } catch (error) {
      const errorReply = sendRouteConfigurationMutationError(reply, error);
      if (errorReply) return errorReply;
      throw error;
    }
  });

  // Rebuild routes/channels from model availability.
  app.post<{ Body: unknown }>('/api/routes/rebuild', async (request, reply) => {
    const parsedBody = parseRouteRebuildPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const body = parsedBody.data;
    if (body.refreshModels === false) {
      const rebuild = await routeRefreshWorkflow.rebuildRoutesOnly();
      return { success: true, rebuild };
    }

    if (body.wait) {
      const result = await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
      return { success: true, ...result };
    }

    const { task, reused } = startBackgroundTask(
      {
        type: 'route',
        title: '刷新模型并重建路由',
        dedupeKey: 'refresh-models-and-rebuild-routes',
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const rebuild = (currentTask.result as any)?.rebuild;
          if (!rebuild) return '刷新模型并重建路由已完成';
          return `刷新模型并重建路由完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
        },
        failureMessage: (currentTask) => `刷新模型并重建路由失败：${currentTask.error || 'unknown error'}`,
      },
      async () => routeRefreshWorkflow.refreshModelsAndRebuildRoutes(),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '路由重建任务执行中，请稍后查看程序日志'
        : '已开始路由重建，请稍后查看程序日志',
    });
  });
}

