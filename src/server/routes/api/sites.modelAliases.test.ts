import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');

describe('sites model aliases API', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-model-aliases-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.siteModelAliases).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('replaces and lists one site alias set', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'alias-site',
      url: 'https://alias.example.com',
      platform: 'new-api',
    }).returning().get();

    const putResponse = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}/model-aliases`,
      payload: {
        aliases: [
          { sourceModel: ' gpt-4o ', aliasModel: ' team-fast ', enabled: true },
          { sourceModel: 'claude-sonnet', aliasModel: 'team-reasoning', enabled: false },
        ],
      },
    });

    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toEqual({
      siteId: site.id,
      aliases: [
        { sourceModel: 'gpt-4o', aliasModel: 'team-fast', enabled: true },
        { sourceModel: 'claude-sonnet', aliasModel: 'team-reasoning', enabled: false },
      ],
      rebuild: { routesSynchronized: true },
    });

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/model-aliases`,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual({
      siteId: site.id,
      aliases: [
        { sourceModel: 'gpt-4o', aliasModel: 'team-fast', enabled: true },
        { sourceModel: 'claude-sonnet', aliasModel: 'team-reasoning', enabled: false },
      ],
    });
  });

  it('rejects an alias that collides with an existing canonical route', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'conflict-site',
      url: 'https://conflict.example.com',
      platform: 'new-api',
    }).returning().get();
    await db.insert(schema.tokenRoutes).values({
      modelPattern: 'public-model',
      displayName: 'public-model',
      enabled: true,
    }).run();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}/model-aliases`,
      payload: { aliases: [{ sourceModel: 'upstream-model', aliasModel: 'PUBLIC-MODEL' }] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining('canonical'),
      code: 'canonical_conflict',
    });
  });

  it('returns 404 for a missing site and 400 for an invalid alias body', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/sites/999999/model-aliases',
    });
    expect(missing.statusCode).toBe(404);

    const site = await db.insert(schema.sites).values({
      name: 'invalid-site',
      url: 'https://invalid.example.com',
      platform: 'new-api',
    }).returning().get();
    const invalid = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}/model-aliases`,
      payload: { aliases: [{ sourceModel: '', aliasModel: 'team-fast' }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_alias' });
  });
});
