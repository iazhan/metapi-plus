import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type AliasServiceModule = typeof import('./siteModelAliasService.js');

describe('site model alias persistence', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let listSiteModelAliases: AliasServiceModule['listSiteModelAliases'];
  let replaceSiteModelAliases: AliasServiceModule['replaceSiteModelAliases'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-model-alias-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const aliasService = await import('./siteModelAliasService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    listSiteModelAliases = aliasService.listSiteModelAliases;
    replaceSiteModelAliases = aliasService.replaceSiteModelAliases;
  });

  beforeEach(async () => {
    await db.delete(schema.siteModelAliases).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('atomically replaces one site alias set with normalized rows', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'alias-site',
      url: 'https://alias-site.example.com',
      platform: 'new-api',
    }).returning().get();

    await replaceSiteModelAliases(site.id, [
      { sourceModel: '  GPT-4O  ', aliasModel: ' Fast-Model ', enabled: false },
    ]);
    const aliases = await listSiteModelAliases(site.id);

    expect(aliases).toEqual([
      { sourceModel: 'GPT-4O', aliasModel: 'Fast-Model', enabled: false },
    ]);

    const stored = await db.select().from(schema.siteModelAliases)
      .where(eq(schema.siteModelAliases.siteId, site.id))
      .get();
    expect(stored?.aliasKey).toBe('fast-model');

    await replaceSiteModelAliases(site.id, [
      { sourceModel: 'claude-sonnet', aliasModel: 'balanced' },
    ]);

    expect(await listSiteModelAliases(site.id)).toEqual([
      { sourceModel: 'claude-sonnet', aliasModel: 'balanced', enabled: true },
    ]);
  });

  it('keeps the previous alias set when canonical conflict validation fails', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'conflict-site',
      url: 'https://conflict.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'conflict-user',
      accessToken: '',
      apiToken: 'sk-conflict',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'canonical-model',
      available: true,
    }).run();
    await replaceSiteModelAliases(site.id, [
      { sourceModel: 'upstream-model', aliasModel: 'existing-alias' },
    ]);

    await expect(replaceSiteModelAliases(site.id, [
      { sourceModel: 'upstream-model', aliasModel: 'CANONICAL-MODEL' },
    ])).rejects.toMatchObject({
      name: 'SiteModelAliasInputError',
      issue: { code: 'canonical_conflict', index: 0 },
    });
    expect(await listSiteModelAliases(site.id)).toEqual([
      { sourceModel: 'upstream-model', aliasModel: 'existing-alias', enabled: true },
    ]);
  });

  it('requires one exact alias spelling across sites that share an alias identity', async () => {
    const siteA = await db.insert(schema.sites).values({
      name: 'spelling-site-a',
      url: 'https://spelling-a.example.com',
      platform: 'new-api',
    }).returning().get();
    const siteB = await db.insert(schema.sites).values({
      name: 'spelling-site-b',
      url: 'https://spelling-b.example.com',
      platform: 'new-api',
    }).returning().get();

    await replaceSiteModelAliases(siteA.id, [
      { sourceModel: 'source-a', aliasModel: 'Shared-Alias' },
    ]);

    await expect(replaceSiteModelAliases(siteB.id, [
      { sourceModel: 'source-b', aliasModel: 'shared-alias' },
    ])).rejects.toMatchObject({
      name: 'SiteModelAliasInputError',
      issue: { code: 'alias_spelling_conflict', index: 0 },
    });
    expect(await listSiteModelAliases(siteB.id)).toEqual([]);

    await expect(replaceSiteModelAliases(siteB.id, [
      { sourceModel: 'source-b', aliasModel: 'Shared-Alias' },
    ])).resolves.toEqual([
      { sourceModel: 'source-b', aliasModel: 'Shared-Alias', enabled: true },
    ]);
  });
});
