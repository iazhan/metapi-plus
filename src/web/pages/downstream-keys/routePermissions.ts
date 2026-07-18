import { isExactTokenRouteModelPattern } from '../../../shared/tokenRoutePatterns.js';

export type RouteSelectorItem = {
  id: number;
  modelPattern: string;
  displayName?: string | null;
  routeMode?: 'pattern' | 'explicit_group' | null;
  routeKind?: 'site_alias' | null;
  enabled: boolean;
};

export function isExactModelPattern(modelPattern: string): boolean {
  return isExactTokenRouteModelPattern(modelPattern);
}

export function isGroupRouteOption(route: RouteSelectorItem): boolean {
  return route.routeMode === 'explicit_group' || !isExactModelPattern(route.modelPattern);
}

export function isExactModelOption(route: RouteSelectorItem): boolean {
  // Site aliases stay name-based so permission survives regeneration of their derived route IDs.
  return !isGroupRouteOption(route) && isExactModelPattern(route.modelPattern);
}

export function getRoutePermissionModelName(route: RouteSelectorItem): string {
  return route.displayName?.trim() || route.modelPattern.trim();
}

export function normalizeExistingRoutePermissions(input: {
  supportedModels: string[];
  allowedRouteIds: number[];
  routeOptions: RouteSelectorItem[];
}): { selectedModels: string[]; selectedGroupRouteIds: number[]; legacyModelRules: string[] } {
  const exactRoutes = input.routeOptions.filter(isExactModelOption);
  const exposedExactModelByAcceptedName = new Map<string, string>();
  for (const route of exactRoutes) {
    const exposedName = getRoutePermissionModelName(route);
    exposedExactModelByAcceptedName.set(exposedName, exposedName);
    exposedExactModelByAcceptedName.set(route.modelPattern.trim(), exposedName);
  }
  const groupRoutes = input.routeOptions.filter(isGroupRouteOption);
  const groupRouteIds = new Set(groupRoutes.map((route) => route.id));
  const routesById = new Map(input.routeOptions.map((route) => [route.id, route]));
  const selectedModels = new Set<string>();
  const selectedGroupRouteIds = new Set<number>();
  const legacyModelRules = new Set<string>();

  for (const rawId of input.allowedRouteIds) {
    const routeId = Math.trunc(Number(rawId));
    if (!Number.isFinite(routeId)) continue;
    if (groupRouteIds.has(routeId)) {
      selectedGroupRouteIds.add(routeId);
      continue;
    }
    const exactRoute = routesById.get(routeId);
    if (exactRoute && isExactModelOption(exactRoute)) {
      selectedModels.add(getRoutePermissionModelName(exactRoute));
    }
  }

  for (const rawModel of input.supportedModels) {
    const model = String(rawModel || '').trim();
    if (!model) continue;
    const exposedExactName = exposedExactModelByAcceptedName.get(model);
    if (exposedExactName) {
      selectedModels.add(exposedExactName);
      continue;
    }

    let matchedGroup = false;
    for (const route of groupRoutes) {
      const exposedName = getRoutePermissionModelName(route);
      if (route.modelPattern.trim() === model || exposedName === model) {
        selectedGroupRouteIds.add(route.id);
        matchedGroup = true;
      }
    }
    if (!matchedGroup) legacyModelRules.add(model);
  }

  return {
    selectedModels: Array.from(selectedModels).sort((left, right) => left.localeCompare(right)),
    selectedGroupRouteIds: Array.from(selectedGroupRouteIds).sort((left, right) => left - right),
    legacyModelRules: Array.from(legacyModelRules).sort((left, right) => left.localeCompare(right)),
  };
}
