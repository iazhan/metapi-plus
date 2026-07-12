import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDataDir, type TestDataDir } from '../../test-fixtures/testDataDir.js';

const loginMock = vi.fn();
const getApiTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const getGroupRatesMock = vi.fn();
const convergeAccountMutationMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    login: (...args: unknown[]) => loginMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
    getGroupRates: (...args: unknown[]) => getGroupRatesMock(...args),
  }),
}));

vi.mock('../../services/accountMutationWorkflow.js', () => ({
  convergeAccountMutation: (...args: unknown[]) => convergeAccountMutationMock(...args),
  rebuildRoutesBestEffort: vi.fn(),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts login platform user id', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-accounts-login-platform-id-');
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    loginMock.mockReset();
    getApiTokenMock.mockReset();
    getApiTokensMock.mockReset();
    getGroupRatesMock.mockReset();
    convergeAccountMutationMock.mockReset();
    await db.delete(schema.accountGroupRates).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    await testDataDir.cleanup(closeDbConnections);
  });

  it('uses and persists the real user id returned by account-password login', async () => {
    loginMock.mockResolvedValue({
      success: true,
      accessToken: 'session-cookie',
      platformUserId: 4242,
    });
    getApiTokenMock.mockResolvedValue('sk-primary');
    getApiTokensMock.mockResolvedValue([
      { name: 'primary', key: 'sk-primary', enabled: true, tokenGroup: 'default' },
    ]);
    getGroupRatesMock.mockResolvedValue([
      { groupKey: 'default', groupName: 'Default', ratio: 1 },
    ]);
    convergeAccountMutationMock.mockImplementation(async (input: { upstreamTokens?: unknown[] }) => ({
      defaultTokenId: input.upstreamTokens?.length ? 101 : null,
      tokenSync: input.upstreamTokens?.length
        ? { created: 1, updated: 0, maskedPending: 0, pendingTokenIds: [], total: 1, defaultTokenId: 101 }
        : null,
    }));
    const site = await db.insert(schema.sites).values({
      name: 'NewAPI Site',
      url: 'https://newapi.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: {
        siteId: site.id,
        username: 'person@example.com',
        password: 'password',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      apiTokenFound: true,
      tokenCount: 1,
      rateSync: { status: 'synced', total: 1 },
    });
    expect(getApiTokenMock).not.toHaveBeenCalled();
    expect(getApiTokensMock).toHaveBeenCalledWith(
      site.url,
      'session-cookie',
      4242,
      expect.any(AbortSignal),
    );
    expect(getGroupRatesMock).toHaveBeenCalledWith(
      site.url,
      'session-cookie',
      4242,
      expect.any(AbortSignal),
    );
    const account = await db.select().from(schema.accounts).where(eq(schema.accounts.siteId, site.id)).get();
    expect(JSON.parse(String(account?.extraConfig))).toMatchObject({ platformUserId: 4242 });
    await expect(db.select().from(schema.accountGroupRates)
      .where(eq(schema.accountGroupRates.accountId, account!.id)).all())
      .resolves.toEqual([expect.objectContaining({ groupKey: 'default', ratio: 1 })]);
  });
});
