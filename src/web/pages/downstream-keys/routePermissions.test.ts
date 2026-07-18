import { describe, expect, it } from 'vitest';
import {
  isExactModelOption,
  isGroupRouteOption,
  normalizeExistingRoutePermissions,
} from './routePermissions.js';

describe('downstream route permission classification', () => {
  it('uses route mode to keep exact-named explicit groups out of exact model permissions', () => {
    const route = {
      id: 1,
      modelPattern: 'team-reasoning',
      routeMode: 'explicit_group' as const,
      enabled: true,
    };

    expect(isGroupRouteOption(route)).toBe(true);
    expect(isExactModelOption(route)).toBe(false);
  });

  it('keeps generated site aliases in name-based exact model permissions', () => {
    const route = {
      id: 2,
      modelPattern: 'stable-fast',
      routeKind: 'site_alias' as const,
      enabled: true,
    };

    expect(isGroupRouteOption(route)).toBe(false);
    expect(isExactModelOption(route)).toBe(true);
  });

  it('normalizes exact route permissions to the externally exposed display name', () => {
    const route = {
      id: 4,
      modelPattern: 'gpt-4o',
      displayName: 'team-fast',
      enabled: true,
    };

    expect(normalizeExistingRoutePermissions({
      supportedModels: ['gpt-4o'],
      allowedRouteIds: [],
      routeOptions: [route],
    })).toEqual({
      selectedModels: ['team-fast'],
      selectedGroupRouteIds: [],
      legacyModelRules: [],
    });
  });

  it.each(['model-*', 'model?', 're:^model'])('classifies pattern routes as route groups: %s', (modelPattern) => {
    const route = { id: 3, modelPattern, enabled: true };
    expect(isGroupRouteOption(route)).toBe(true);
    expect(isExactModelOption(route)).toBe(false);
  });

  it('migrates visible group patterns to route ids and keeps unmatched legacy rules visible', () => {
    const routes = [
      { id: 1, modelPattern: 'gpt-4.1-mini', enabled: true },
      { id: 2, modelPattern: 'team-reasoning', routeMode: 'explicit_group' as const, enabled: true },
      { id: 3, modelPattern: 'claude-*', displayName: 'Claude 系列', enabled: true },
    ];

    expect(normalizeExistingRoutePermissions({
      supportedModels: ['gpt-4.1-mini', 'team-reasoning', 'claude-*', 'orphan-*'],
      allowedRouteIds: [1, 3, 999],
      routeOptions: routes,
    })).toEqual({
      selectedModels: ['gpt-4.1-mini'],
      selectedGroupRouteIds: [2, 3],
      legacyModelRules: ['orphan-*'],
    });
  });
});
