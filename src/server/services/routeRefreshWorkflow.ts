import { startBackgroundTask } from './backgroundTaskService.js';
import { db } from '../db/index.js';
import {
  rebuildTokenRoutesProjection,
  rebuildTokenRoutesFromAvailability,
  refreshModelsAndRebuildRoutes as refreshModelsAndRebuildRoutesViaModelService,
} from './modelService.js';
import { replaceSiteModelAliases } from './siteModelAliasService.js';
import { runRouteProjectionExclusive } from './routeProjectionCoordinator.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';

export async function rebuildRoutesOnly() {
  return rebuildTokenRoutesFromAvailability();
}

export async function rebuildRoutesBestEffort() {
  try {
    await rebuildRoutesOnly();
    return true;
  } catch {
    return false;
  }
}

export async function replaceSiteModelAliasesAndRebuildRoutes(siteId: number, input: unknown) {
  return runRouteProjectionExclusive(async () => {
    const result = await db.transaction(async (tx: typeof db) => {
      const aliases = await replaceSiteModelAliases(siteId, input, tx);
      await rebuildTokenRoutesProjection(tx);
      return {
        siteId,
        aliases,
        rebuild: { routesSynchronized: true as const },
      };
    });
    invalidateTokenRouterCache();
    return result;
  });
}

export async function refreshModelsAndRebuildRoutes() {
  return refreshModelsAndRebuildRoutesViaModelService();
}

export function queueRefreshModelsAndRebuildRoutesTask(input: {
  type: string;
  title: string;
  dedupeKey?: string;
  notifyOnFailure?: boolean;
  successMessage: (currentTask: { result?: unknown }) => string;
  failureMessage: (currentTask: { error?: string | null }) => string;
}) {
  return startBackgroundTask(
    {
      type: input.type,
      title: input.title,
      dedupeKey: input.dedupeKey || 'refresh-models-and-rebuild-routes',
      notifyOnFailure: input.notifyOnFailure ?? true,
      successMessage: input.successMessage,
      failureMessage: input.failureMessage,
    },
    async () => refreshModelsAndRebuildRoutes(),
  );
}
