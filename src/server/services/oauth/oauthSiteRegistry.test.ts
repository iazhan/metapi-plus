import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataDir, type TestDataDir } from '../../test-fixtures/testDataDir.js';

type DbModule = typeof import('../../db/index.js');

describe('oauth site registry', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-oauth-site-registry-');
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
  });

  beforeEach(async () => {
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await testDataDir.cleanup(closeDbConnections);
  });

  it('creates missing oauth provider sites without duplicating existing rows', async () => {
    await db.insert(schema.sites).values({
      name: 'Anthropic Claude OAuth',
      url: 'https://api.anthropic.com',
      platform: 'claude',
      status: 'active',
      useSystemProxy: true,
    }).run();

    const { ensureOauthProviderSitesExist } = await import('./oauthSiteRegistry.js');
    await ensureOauthProviderSitesExist();

    const rows = await db.select().from(schema.sites).all();
    expect(rows.filter((row) => row.platform === 'codex')).toHaveLength(1);
    expect(rows.filter((row) => row.platform === 'gemini-cli')).toHaveLength(1);
    expect(rows.filter((row) => row.platform === 'antigravity')).toHaveLength(1);
    expect(rows.filter((row) => row.platform === 'claude')).toHaveLength(1);
  });
});
