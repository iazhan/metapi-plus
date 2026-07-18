import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');
type AliasServiceModule = typeof import('./siteModelAliasService.js');
type RouteRefreshWorkflowModule = typeof import('./routeRefreshWorkflow.js');
type ConfigModule = typeof import('../config.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('rebuildTokenRoutesFromAvailability with site model aliases', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let rebuildTokenRoutesFromAvailability: ModelServiceModule['rebuildTokenRoutesFromAvailability'];
  let replaceSiteModelAliases: AliasServiceModule['replaceSiteModelAliases'];
  let replaceSiteModelAliasesAndRebuildRoutes: RouteRefreshWorkflowModule['replaceSiteModelAliasesAndRebuildRoutes'];
  let config: ConfigModule['config'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-service-site-aliases-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');
    const aliasService = await import('./siteModelAliasService.js');
    const routeRefreshWorkflow = await import('./routeRefreshWorkflow.js');
    const configModule = await import('../config.js');
    const tokenRouterModule = await import('./tokenRouter.js');

    db = dbModule.db;
    schema = dbModule.schema;
    rebuildTokenRoutesFromAvailability = modelService.rebuildTokenRoutesFromAvailability;
    replaceSiteModelAliases = aliasService.replaceSiteModelAliases;
    replaceSiteModelAliasesAndRebuildRoutes = routeRefreshWorkflow.replaceSiteModelAliasesAndRebuildRoutes;
    config = configModule.config;
    TokenRouter = tokenRouterModule.TokenRouter;
  });

  beforeEach(async () => {
    config.globalAllowedModels = [];
    config.globalBlockedBrands = [];
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.siteModelAliases).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    config.globalAllowedModels = [];
    config.globalBlockedBrands = [];
    delete process.env.DATA_DIR;
  });

  it('keeps the canonical route and adds a marked alias route with the real source model', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'alias-site',
      url: 'https://alias.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alias-user',
      accessToken: '',
      apiToken: 'sk-alias',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'GPT-4O',
      available: true,
    }).run();
    await replaceSiteModelAliases(site.id, [
      { sourceModel: ' gpt-4o ', aliasModel: ' Fast-Model ' },
    ]);

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(2);
    const canonicalRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'GPT-4O'))
      .get();
    const aliasRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'Fast-Model'))
      .get();
    expect(canonicalRoute?.routeKind ?? null).toBeNull();
    expect(aliasRoute?.routeKind).toBe('site_alias');
    expect(aliasRoute?.displayName).toBe('Fast-Model');

    const canonicalChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, canonicalRoute!.id))
      .all();
    const aliasChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, aliasRoute!.id))
      .all();
    expect(canonicalChannels).toHaveLength(1);
    expect(aliasChannels).toHaveLength(1);
    expect(aliasChannels[0]?.sourceModel).toBe('GPT-4O');

    const router = new TokenRouter();
    const selected = await router.selectChannel('Fast-Model');
    expect(selected).toBeTruthy();
    expect(selected?.channel.id).toBe(aliasChannels[0]?.id);
    expect(selected?.actualModel).toBe('GPT-4O');
    expect(await router.getAvailableModels()).toEqual(expect.arrayContaining(['GPT-4O', 'Fast-Model']));
  });

  it('keeps a disabled rule but removes its generated alias route', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'toggle-site',
      url: 'https://toggle.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'toggle-user',
      accessToken: '',
      apiToken: 'sk-toggle',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'source-model',
      available: true,
    }).run();
    await replaceSiteModelAliases(site.id, [
      { sourceModel: 'source-model', aliasModel: 'public-model', enabled: true },
    ]);
    await rebuildTokenRoutesFromAvailability();

    expect(await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'public-model'))
      .get()).toBeDefined();

    await replaceSiteModelAliases(site.id, [
      { sourceModel: 'source-model', aliasModel: 'public-model', enabled: false },
    ]);
    await rebuildTokenRoutesFromAvailability();

    expect(await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'public-model'))
      .get()).toBeUndefined();
    expect(await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'source-model'))
      .get()).toBeDefined();
    expect(await replaceSiteModelAliases(site.id, [
      { sourceModel: 'source-model', aliasModel: 'public-model', enabled: false },
    ])).toEqual([
      { sourceModel: 'source-model', aliasModel: 'public-model', enabled: false },
    ]);
  });

  it('combines the same alias across sites while preserving each real source model', async () => {
    const siteA = await db.insert(schema.sites).values({
      name: 'site-a', url: 'https://site-a.example.com', platform: 'new-api',
    }).returning().get();
    const siteB = await db.insert(schema.sites).values({
      name: 'site-b', url: 'https://site-b.example.com', platform: 'new-api',
    }).returning().get();
    const accountA = await db.insert(schema.accounts).values({
      siteId: siteA.id,
      username: 'user-a',
      accessToken: '',
      apiToken: 'sk-a',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: siteB.id,
      username: 'user-b',
      accessToken: '',
      apiToken: 'sk-b',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'source-a', available: true },
      { accountId: accountB.id, modelName: 'SOURCE-B', available: true },
    ]).run();
    await replaceSiteModelAliases(siteA.id, [
      { sourceModel: 'source-a', aliasModel: 'Shared-Alias' },
    ]);
    await replaceSiteModelAliases(siteB.id, [
      { sourceModel: 'source-b', aliasModel: 'Shared-Alias' },
    ]);

    await rebuildTokenRoutesFromAvailability();

    const aliasRoutes = (await db.select().from(schema.tokenRoutes).all())
      .filter((route: typeof schema.tokenRoutes.$inferSelect) => (
        route.modelPattern.toLowerCase() === 'shared-alias'
      ));
    expect(aliasRoutes).toHaveLength(1);
    expect(aliasRoutes[0]?.routeKind).toBe('site_alias');
    expect(aliasRoutes[0]?.modelPattern).toBe('Shared-Alias');
    const aliasChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, aliasRoutes[0]!.id))
      .all();
    expect(aliasChannels.map((channel: typeof schema.routeChannels.$inferSelect) => channel.sourceModel).sort())
      .toEqual(['SOURCE-B', 'source-a']);

    await db.delete(schema.sites).where(eq(schema.sites.id, siteA.id)).run();
    await rebuildTokenRoutesFromAvailability();

    const remainingAliasRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.id, aliasRoutes[0]!.id))
      .get();
    expect(remainingAliasRoute?.modelPattern).toBe('Shared-Alias');
    const remainingChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, aliasRoutes[0]!.id))
      .all();
    expect(remainingChannels.map((channel) => channel.sourceModel)).toEqual(['SOURCE-B']);
  });

  it('gives a newly discovered canonical model precedence over a colliding alias', async () => {
    const aliasSite = await db.insert(schema.sites).values({
      name: 'alias-site', url: 'https://alias-source.example.com', platform: 'new-api',
    }).returning().get();
    const canonicalSite = await db.insert(schema.sites).values({
      name: 'canonical-site', url: 'https://canonical-source.example.com', platform: 'new-api',
    }).returning().get();
    const aliasAccount = await db.insert(schema.accounts).values({
      siteId: aliasSite.id,
      username: 'alias-user',
      accessToken: '',
      apiToken: 'sk-alias-source',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    const canonicalAccount = await db.insert(schema.accounts).values({
      siteId: canonicalSite.id,
      username: 'canonical-user',
      accessToken: '',
      apiToken: 'sk-canonical-source',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: aliasAccount.id,
      modelName: 'upstream-only',
      available: true,
    }).run();
    await replaceSiteModelAliases(aliasSite.id, [
      { sourceModel: 'upstream-only', aliasModel: 'future-canonical' },
    ]);
    await rebuildTokenRoutesFromAvailability();

    await db.insert(schema.modelAvailability).values({
      accountId: canonicalAccount.id,
      modelName: 'FUTURE-CANONICAL',
      available: true,
    }).run();
    await rebuildTokenRoutesFromAvailability();

    const collidingRoutes = (await db.select().from(schema.tokenRoutes).all())
      .filter((route: typeof schema.tokenRoutes.$inferSelect) => (
        route.modelPattern.toLowerCase() === 'future-canonical'
      ));
    expect(collidingRoutes).toHaveLength(1);
    expect(collidingRoutes[0]?.routeKind ?? null).toBeNull();
    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, collidingRoutes[0]!.id))
      .all();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.accountId).toBe(canonicalAccount.id);
    expect(channels[0]?.sourceModel ?? null).toBeNull();
  });

  it('persists and synchronizes routes through the shared refresh workflow', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'workflow-site', url: 'https://workflow.example.com', platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'workflow-user',
      accessToken: '',
      apiToken: 'sk-workflow',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'workflow-source',
      available: true,
    }).run();

    const result = await replaceSiteModelAliasesAndRebuildRoutes(site.id, [
      { sourceModel: 'workflow-source', aliasModel: 'workflow-alias', enabled: true },
    ]);

    expect(result).toEqual({
      siteId: site.id,
      aliases: [{ sourceModel: 'workflow-source', aliasModel: 'workflow-alias', enabled: true }],
      rebuild: { routesSynchronized: true },
    });
    expect(await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'workflow-alias'))
      .get()).toMatchObject({ routeKind: 'site_alias' });
  });

  it('does not let an alias bypass the global model whitelist', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'whitelist-site', url: 'https://whitelist.example.com', platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'whitelist-user',
      accessToken: '',
      apiToken: 'sk-whitelist',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'allowed-source',
      available: true,
    }).run();
    await replaceSiteModelAliases(site.id, [
      { sourceModel: 'allowed-source', aliasModel: 'blocked-alias' },
    ]);
    config.globalAllowedModels = ['allowed-source'];

    await rebuildTokenRoutesFromAvailability();

    expect(await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'allowed-source'))
      .get()).toBeDefined();
    expect(await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'blocked-alias'))
      .get()).toBeUndefined();
  });

  it('does not let an alias bypass a site-level disabled model rule', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'disabled-alias-site', url: 'https://disabled-alias.example.com', platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'disabled-alias-user',
      accessToken: '',
      apiToken: 'sk-disabled-alias',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'enabled-source',
      available: true,
    }).run();
    await db.insert(schema.siteDisabledModels).values({
      siteId: site.id,
      modelName: 'disabled-alias',
    }).run();
    await replaceSiteModelAliases(site.id, [
      { sourceModel: 'enabled-source', aliasModel: 'disabled-alias' },
    ]);

    await rebuildTokenRoutesFromAvailability();

    expect(await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'enabled-source'))
      .get()).toBeDefined();
    expect(await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'disabled-alias'))
      .get()).toBeUndefined();
  });

  it('refreshes the stored source model spelling when discovery changes it', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'source-case-site', url: 'https://source-case.example.com', platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'source-case-user',
      accessToken: '',
      apiToken: 'sk-source-case',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    const availability = await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'Model-V1',
      available: true,
    }).returning().get();
    await replaceSiteModelAliases(site.id, [
      { sourceModel: 'model-v1', aliasModel: 'stable-alias' },
    ]);
    await rebuildTokenRoutesFromAvailability();
    await db.update(schema.modelAvailability)
      .set({ modelName: 'model-v1' })
      .where(eq(schema.modelAvailability.id, availability.id))
      .run();
    await replaceSiteModelAliases(site.id, [
      { sourceModel: 'MODEL-V1', aliasModel: 'Stable-Alias' },
    ]);

    await rebuildTokenRoutesFromAvailability();

    const aliasRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'Stable-Alias'))
      .get();
    expect(aliasRoute?.displayName).toBe('Stable-Alias');
    const aliasChannel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, aliasRoute!.id))
      .get();
    expect(aliasChannel?.sourceModel).toBe('model-v1');
  });

  it('repairs managed alias route metadata and removes rogue manual channels', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'alias-repair-site', url: 'https://alias-repair.example.com', platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alias-repair-user',
      accessToken: '',
      apiToken: 'sk-alias-repair',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'repair-source',
      available: true,
    }).run();
    await replaceSiteModelAliases(site.id, [
      { sourceModel: 'repair-source', aliasModel: 'repair-alias' },
    ]);
    await rebuildTokenRoutesFromAvailability();

    const aliasRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'repair-alias'))
      .get();
    const generatedChannel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, aliasRoute!.id))
      .get();
    await db.update(schema.tokenRoutes).set({
      displayName: 'stale-alias',
      displayIcon: 'stale-icon',
      modelMapping: JSON.stringify({ 'repair-alias': 'wrong-source' }),
      routingStrategy: 'round_robin',
      enabled: false,
    }).where(eq(schema.tokenRoutes.id, aliasRoute!.id)).run();
    await db.update(schema.routeChannels).set({ manualOverride: true })
      .where(eq(schema.routeChannels.id, generatedChannel!.id))
      .run();
    const rogueChannel = await db.insert(schema.routeChannels).values({
      routeId: aliasRoute!.id,
      accountId: account.id,
      tokenId: null,
      sourceModel: 'wrong-source',
      enabled: true,
      manualOverride: true,
    }).returning().get();

    await rebuildTokenRoutesFromAvailability();

    const repairedRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.id, aliasRoute!.id))
      .get();
    expect(repairedRoute).toMatchObject({
      displayName: 'repair-alias',
      displayIcon: null,
      modelMapping: null,
      routeMode: 'pattern',
      routeKind: 'site_alias',
      routingStrategy: 'weighted',
      enabled: true,
    });

    const repairedChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, aliasRoute!.id))
      .all();
    expect(repairedChannels).toHaveLength(1);
    expect(repairedChannels[0]).toMatchObject({
      id: generatedChannel!.id,
      sourceModel: 'repair-source',
      manualOverride: false,
    });
    expect(repairedChannels.some((channel) => channel.id === rogueChannel.id)).toBe(false);
  });

  it('does not duplicate an existing canonical connection because it has a manual source model', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'canonical-existing-site', url: 'https://canonical-existing.example.com', platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'canonical-existing-user',
      accessToken: '',
      apiToken: 'sk-canonical-existing',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'canonical-existing',
      available: true,
    }).run();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'canonical-existing',
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      sourceModel: 'manual-source',
      enabled: true,
      manualOverride: true,
    }).returning().get();

    await rebuildTokenRoutesFromAvailability();

    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, route.id))
      .all();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ id: channel.id, sourceModel: 'manual-source', manualOverride: true });
  });
});
