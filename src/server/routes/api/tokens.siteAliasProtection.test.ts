import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('managed site alias route protection', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-alias-route-protection-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.siteModelAliases).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('rejects direct update, delete, and batch mutation of managed alias routes', async () => {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'team-fast',
      routeKind: 'site_alias',
      enabled: true,
    }).returning().get();
    const site = await db.insert(schema.sites).values({
      name: 'alias-protection-site', url: 'https://alias-protection.example', platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id, username: 'alias-user', accessToken: 'session', status: 'active',
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      sourceModel: 'gpt-4o',
      enabled: true,
    }).returning().get();

    const update = await app.inject({
      method: 'PUT',
      url: `/api/routes/${route.id}`,
      payload: { enabled: false },
    });
    expect(update.statusCode).toBe(409);

    const batch = await app.inject({
      method: 'POST',
      url: '/api/routes/batch',
      payload: { ids: [route.id], action: 'disable' },
    });
    expect(batch.statusCode).toBe(409);

    const clearCooldown = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/cooldown/clear`,
    });
    expect(clearCooldown.statusCode).toBe(409);

    const remove = await app.inject({ method: 'DELETE', url: `/api/routes/${route.id}` });
    expect(remove.statusCode).toBe(409);

    const addChannel = await app.inject({
      method: 'POST', url: `/api/routes/${route.id}/channels`, payload: { accountId: account.id },
    });
    expect(addChannel.statusCode).toBe(409);

    const addChannels = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels/batch`,
      payload: { channels: [{ accountId: account.id, sourceModel: 'gpt-4o' }] },
    });
    expect(addChannels.statusCode).toBe(409);

    const reorderChannels = await app.inject({
      method: 'PUT',
      url: '/api/channels/batch',
      payload: { updates: [{ id: channel.id, priority: 1 }] },
    });
    expect(reorderChannels.statusCode).toBe(409);

    const updateChannel = await app.inject({
      method: 'PUT', url: `/api/channels/${channel.id}`, payload: { enabled: false },
    });
    expect(updateChannel.statusCode).toBe(409);

    const deleteChannel = await app.inject({ method: 'DELETE', url: `/api/channels/${channel.id}` });
    expect(deleteChannel.statusCode).toBe(409);

    const stored = await db.select().from(schema.tokenRoutes).get();
    expect(stored).toMatchObject({ id: route.id, enabled: true, routeKind: 'site_alias' });
  });

  it('rejects manual route creation that reuses an existing site alias name', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'alias-namespace-site', url: 'https://alias-namespace.example', platform: 'new-api',
    }).returning().get();
    await db.insert(schema.siteModelAliases).values({
      siteId: site.id,
      sourceModel: 'gpt-4o',
      aliasModel: 'Team-Fast',
      aliasKey: 'team-fast',
      enabled: true,
    }).run();

    for (const payload of [
      { routeMode: 'pattern', modelPattern: 'TEAM-FAST' },
      { routeMode: 'pattern', modelPattern: 'gpt-*', displayName: 'team-fast' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/routes', payload });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ success: false, code: 'site_alias_name_conflict' });
    }

    expect(await db.select().from(schema.tokenRoutes).all()).toEqual([]);
  });

  it('rejects manual route updates that reuse an existing site alias name', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'alias-update-site', url: 'https://alias-update.example', platform: 'new-api',
    }).returning().get();
    await db.insert(schema.siteModelAliases).values({
      siteId: site.id,
      sourceModel: 'gpt-4o',
      aliasModel: 'Team-Fast',
      aliasKey: 'team-fast',
      enabled: true,
    }).run();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'manual-original',
      displayName: null,
      enabled: true,
    }).returning().get();

    for (const payload of [
      { modelPattern: 'team-fast' },
      { displayName: 'TEAM-FAST' },
    ]) {
      const response = await app.inject({ method: 'PUT', url: `/api/routes/${route.id}`, payload });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ success: false, code: 'site_alias_name_conflict' });
    }

    expect(await db.select().from(schema.tokenRoutes).get()).toMatchObject({
      id: route.id,
      modelPattern: 'manual-original',
      displayName: null,
    });
  });

  it('rejects managed alias routes as explicit-group sources on create and update', async () => {
    const aliasRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'team-fast',
      displayName: 'team-fast',
      routeKind: 'site_alias',
      routingStrategy: 'weighted',
      enabled: true,
    }).returning().get();
    const canonicalRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o',
      enabled: true,
    }).returning().get();

    const create = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'team-group',
        sourceRouteIds: [aliasRoute.id],
        routingStrategy: 'round_robin',
      },
    });
    expect(create.statusCode).toBe(400);
    expect(create.json()).toMatchObject({ success: false });
    expect((await db.select().from(schema.tokenRoutes).all())).toHaveLength(2);

    const groupRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'existing-group',
      displayName: 'existing-group',
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeGroupSources).values({
      groupRouteId: groupRoute.id,
      sourceRouteId: canonicalRoute.id,
    }).run();

    const update = await app.inject({
      method: 'PUT',
      url: `/api/routes/${groupRoute.id}`,
      payload: { sourceRouteIds: [aliasRoute.id], routingStrategy: 'round_robin' },
    });
    expect(update.statusCode).toBe(400);
    expect(update.json()).toMatchObject({ success: false });
    expect(await db.select().from(schema.routeGroupSources).get()).toMatchObject({
      groupRouteId: groupRoute.id,
      sourceRouteId: canonicalRoute.id,
    });
    expect(await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, aliasRoute.id)).get())
      .toMatchObject({ routingStrategy: 'weighted' });
  });
});
