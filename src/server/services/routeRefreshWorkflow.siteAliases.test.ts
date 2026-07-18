import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');

describe('site alias route refresh workflow', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let replaceSiteModelAliasesAndRebuildRoutes: typeof import('./routeRefreshWorkflow.js')['replaceSiteModelAliasesAndRebuildRoutes'];
  let listSiteModelAliases: typeof import('./siteModelAliasService.js')['listSiteModelAliases'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-alias-workflow-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const workflow = await import('./routeRefreshWorkflow.js');
    const aliasService = await import('./siteModelAliasService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    replaceSiteModelAliasesAndRebuildRoutes = workflow.replaceSiteModelAliasesAndRebuildRoutes;
    listSiteModelAliases = aliasService.listSiteModelAliases;
  });

  beforeEach(async () => {
    await db.run(sql.raw('DROP TRIGGER IF EXISTS fail_new_alias_route'));
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.siteModelAliases).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await db.run(sql.raw('DROP TRIGGER IF EXISTS fail_new_alias_route'));
    delete process.env.DATA_DIR;
  });

  it('rolls back alias configuration and derived routes when projection synchronization fails', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'atomic-alias-site',
      url: 'https://atomic-alias.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'atomic-alias-user',
      apiToken: 'sk-atomic-alias',
      accessToken: '',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'source-model',
      available: true,
    }).run();

    await replaceSiteModelAliasesAndRebuildRoutes(site.id, [
      { sourceModel: 'source-model', aliasModel: 'old-alias' },
    ]);
    await db.run(sql.raw(`
      CREATE TRIGGER fail_new_alias_route
      BEFORE INSERT ON token_routes
      WHEN NEW.model_pattern = 'new-alias'
      BEGIN
        SELECT RAISE(ABORT, 'forced projection failure');
      END
    `));

    await expect(replaceSiteModelAliasesAndRebuildRoutes(site.id, [
      { sourceModel: 'source-model', aliasModel: 'new-alias' },
    ])).rejects.toThrow();

    expect(await listSiteModelAliases(site.id)).toEqual([
      { sourceModel: 'source-model', aliasModel: 'old-alias', enabled: true },
    ]);
    expect(await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'old-alias'))
      .get()).toMatchObject({ routeKind: 'site_alias' });
    expect(await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'new-alias'))
      .get()).toBeUndefined();
  });
});
