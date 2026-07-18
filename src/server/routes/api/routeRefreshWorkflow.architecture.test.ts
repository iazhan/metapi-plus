import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function expectNoDirectModelServiceRouteRefresh(source: string): void {
  expect(source).not.toMatch(/import\s*\{[^}]*\brefreshModelsAndRebuildRoutes\b[^}]*\}\s*from\s*['"][^'"]*modelService\.js['"]/m);
  expect(source).not.toMatch(/import\s*\{[^}]*\brebuildTokenRoutesFromAvailability\b[^}]*\}\s*from\s*['"][^'"]*modelService\.js['"]/m);
}

function expectImportsRouteRefreshWorkflow(source: string): void {
  expect(source).toMatch(
    /import\s+\*\s+as\s+routeRefreshWorkflow\s+from\s+['"][^'"]*routeRefreshWorkflow\.js['"]/m,
  );
}

function expectCallsSelectProxyChannelForAttempt(source: string): void {
  expect(source).toMatch(/\bselectProxyChannelForAttempt\s*\(/);
}

function expectCallsRebuildRoutesOnly(source: string): void {
  expect(source).toMatch(/\brouteRefreshWorkflow\.rebuildRoutesOnly\s*\(/);
}

describe('route refresh workflow architecture boundaries', () => {
  it('keeps api controllers on the shared route refresh workflow instead of modelService', () => {
    const tokensSource = readSource('./tokens.ts');
    const settingsSource = readSource('./settings.ts');
    const statsSource = readSource('./stats.ts');

    for (const source of [tokensSource, settingsSource, statsSource]) {
      expectImportsRouteRefreshWorkflow(source);
      expectNoDirectModelServiceRouteRefresh(source);
    }

    expectCallsRebuildRoutesOnly(tokensSource);
    expectCallsRebuildRoutesOnly(statsSource);
  });

  it('keeps proxy fallback refreshes and scheduler hooks on the route refresh workflow', () => {
    const completionsSource = readSource('../proxy/completions.ts');
    const embeddingsSource = readSource('../proxy/embeddings.ts');
    const imagesSource = readSource('../proxy/images.ts');
    const modelsRouteSource = readSource('../proxy/models.ts');
    const searchSource = readSource('../proxy/search.ts');
    const videosSource = readSource('../proxy/videos.ts');
    const schedulerSource = readSource('../../services/checkinScheduler.ts');
    const sharedSurfaceSource = readSource('../../proxy-core/surfaces/sharedSurface.ts');
    const geminiSurfaceSource = readSource('../../proxy-core/surfaces/geminiSurface.ts');
    const channelSelectionSource = readSource('../../proxy-core/channelSelection.ts');

    for (const source of [schedulerSource, channelSelectionSource]) {
      expectImportsRouteRefreshWorkflow(source);
      expectNoDirectModelServiceRouteRefresh(source);
    }

    for (const source of [
      completionsSource,
      embeddingsSource,
      imagesSource,
      modelsRouteSource,
      searchSource,
      videosSource,
      sharedSurfaceSource,
      geminiSurfaceSource,
    ]) {
      expectNoDirectModelServiceRouteRefresh(source);
    }

    for (const source of [
      completionsSource,
      embeddingsSource,
      imagesSource,
      searchSource,
      videosSource,
      sharedSurfaceSource,
    ]) {
      expectCallsSelectProxyChannelForAttempt(source);
    }

    expect(geminiSurfaceSource).toMatch(/\bselectGeminiChannel\s*\(/);
    expect(geminiSurfaceSource).toMatch(/\bselectNextGeminiProbeChannel\s*\(/);
  });

  it('keeps route projection and manual route/channel persistence behind service boundaries', () => {
    const tokensSource = readSource('./tokens.ts');
    const sitesSource = readSource('./sites.ts');
    const routeConfigurationSource = readSource('../../services/routeConfigurationService.ts');
    const routeRefreshSource = readSource('../../services/routeRefreshWorkflow.ts');
    const modelServiceSource = readSource('../../services/modelService.ts');

    for (const routePath of globSync('src/server/routes/**/*.ts')) {
      if (routePath.endsWith('.test.ts')) continue;
      const routeSource = readFileSync(routePath, 'utf8');
      expect(routeSource).not.toContain('routeProjectionCoordinator');
    }

    expect(tokensSource).toContain("from '../../services/routeConfigurationService.js'");
    expect(tokensSource).not.toContain('runRouteConfigurationMutation');
    const batchChannelMutationSection = tokensSource.slice(
      tokensSource.indexOf('// Batch add channels to a route'),
      tokensSource.indexOf('// List all routes'),
    );
    const manualRouteMutationSection = tokensSource.slice(
      tokensSource.indexOf('// Create a route'),
      tokensSource.indexOf('// Rebuild routes/channels from model availability.'),
    );
    for (const mutationSection of [batchChannelMutationSection, manualRouteMutationSection]) {
      expect(mutationSection).not.toContain('db.');
      expect(mutationSection).not.toContain('clearRouteDecisionSnapshot');
      expect(mutationSection).not.toContain('clearDependentExplicitGroupSnapshotsBySourceRouteIds');
      expect(mutationSection).not.toContain('invalidateTokenRouterCache');
    }
    expect(batchChannelMutationSection).toContain('addManualRouteChannels(routeId, parsedBody.data)');
    expect(manualRouteMutationSection).toContain('createManualTokenRoute(parsedBody.data)');
    expect(manualRouteMutationSection).toContain('updateManualTokenRoute(routeId, parsedBody.data)');
    expect(manualRouteMutationSection).toContain('deleteManualTokenRoute(routeId)');
    expect(manualRouteMutationSection).toContain('setManualTokenRoutesEnabled(ids, action === \'enable\')');
    expect(manualRouteMutationSection).toContain('addManualRouteChannel(routeId, parsedBody.data)');
    expect(manualRouteMutationSection).toContain('updateManualRouteChannelPriorities(parsed.updates)');
    expect(manualRouteMutationSection).toContain('updateManualRouteChannel(channelId, parsedBody.data)');
    expect(manualRouteMutationSection).toContain('deleteManualRouteChannel(channelId)');
    expect(routeConfigurationSource).toContain("from './routeProjectionCoordinator.js'");
    expect(routeConfigurationSource).toContain('db.transaction');
    expect(routeRefreshSource).toContain("from './routeProjectionCoordinator.js'");
    expect(modelServiceSource).toContain("from './routeProjectionCoordinator.js'");

    const aliasRouteSection = sitesSource.slice(
      sitesSource.indexOf("'/api/sites/:id/model-aliases'"),
      sitesSource.indexOf('// Get all discovered models for a site'),
    );
    expect(aliasRouteSection).not.toContain('db.');
    expect(aliasRouteSection).toContain('getSiteModelAliases');
    expect(aliasRouteSection).toContain('replaceSiteModelAliasesAndRebuildRoutes');
  });
});
