import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const getApiTokenMock = vi.fn();
const getModelsMock = vi.fn();
const undiciFetchMock = vi.fn();
const proxyAgentCtorMock = vi.fn();

class MockProxyAgent {
  readonly proxyUrl: string;

  constructor(proxyUrl: string) {
    this.proxyUrl = proxyUrl;
    proxyAgentCtorMock(proxyUrl);
  }
}

class MockAgent {}

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
  ProxyAgent: MockProxyAgent,
  Agent: MockAgent,
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('refreshModelsForAccount credential discovery', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let refreshModelsForAccount: ModelServiceModule['refreshModelsForAccount'];
  let refreshModelsAndRebuildRoutes: ModelServiceModule['refreshModelsAndRebuildRoutes'];
  let rebuildTokenRoutesFromAvailability: ModelServiceModule['rebuildTokenRoutesFromAvailability'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-discovery-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    refreshModelsForAccount = modelService.refreshModelsForAccount;
    refreshModelsAndRebuildRoutes = modelService.refreshModelsAndRebuildRoutes;
    rebuildTokenRoutesFromAvailability = modelService.rebuildTokenRoutesFromAvailability;
  });

  beforeEach(async () => {
    getApiTokenMock.mockReset();
    getModelsMock.mockReset();
    undiciFetchMock.mockReset();
    proxyAgentCtorMock.mockReset();

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
    const { config } = await import('../config.js');
    config.systemProxyUrl = '';
    const { invalidateSiteProxyCache } = await import('./siteProxy.js');
    invalidateSiteProxyCache();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('discovers models from account session credential without account_tokens', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => (
      token === 'session-token' ? ['claude-sonnet-4-5-20250929', 'claude-opus-4-6'] : []
    ));

    const site = await db.insert(schema.sites).values({
      name: 'site-a',
      url: 'https://site-a.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      errorCode: null,
      errorMessage: '',
      modelCount: 2,
      modelsPreview: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6'],
      tokenScanned: 0,
      discoveredByCredential: true,
    });

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(rows.map((row) => row.modelName).sort()).toEqual([
      'claude-opus-4-6',
      'claude-sonnet-4-5-20250929',
    ]);

    const tokenRows = await db.select().from(schema.tokenModelAvailability).all();
    expect(tokenRows).toHaveLength(0);
  });

  it('uses the configured ai endpoint for direct model discovery credentials', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (baseUrl: string, token: string) => (
      baseUrl === 'https://api.example.com' && token === 'session-token'
        ? ['gpt-4.1']
        : []
    ));

    const site = await db.insert(schema.sites).values({
      name: 'nihao-panel',
      url: 'https://console.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api.example.com',
      enabled: true,
      sortOrder: 0,
    }).run();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'nihao-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      modelCount: 1,
      modelsPreview: ['gpt-4.1'],
    });
    expect(getModelsMock).toHaveBeenCalledWith('https://api.example.com', 'session-token', undefined);
  });

  it('deduplicates discovered model names before writing availability rows', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockResolvedValue(['? ', '?', 'GPT-4.1', 'gpt-4.1']);

    const site = await db.insert(schema.sites).values({
      name: 'site-dedupe',
      url: 'https://site-dedupe.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'dedupe-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      modelCount: 2,
      modelsPreview: ['?', 'GPT-4.1'],
    });

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();

    expect(rows.map((row) => row.modelName).sort()).toEqual(['?', 'GPT-4.1']);
  });

  it('reuses one in-flight full refresh when concurrent callers request a rebuild', async () => {
    getApiTokenMock.mockResolvedValue(null);

    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    getModelsMock.mockImplementation(async () => {
      await gate;
      return ['gpt-5-nano'];
    });

    const site = await db.insert(schema.sites).values({
      name: 'site-concurrent-refresh',
      url: 'https://site-concurrent-refresh.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'concurrent-refresh-user',
      accessToken: 'shared-credential',
      apiToken: 'shared-credential',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'shared-credential',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).run();

    const firstRefresh = refreshModelsAndRebuildRoutes();
    const secondRefresh = refreshModelsAndRebuildRoutes();
    await Promise.resolve();
    await Promise.resolve();
    releaseGate?.();

    const results = await Promise.allSettled([firstRefresh, secondRefresh]);
    expect(results.every((item) => item.status === 'fulfilled')).toBe(true);
    expect(getModelsMock).toHaveBeenCalledTimes(2);

    const modelRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(modelRows.map((row) => row.modelName)).toEqual(['gpt-5-nano']);

    const token = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .get();
    const tokenRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token!.id))
      .all();
    expect(tokenRows.map((row) => row.modelName)).toEqual(['gpt-5-nano']);
  });

  it('marks runtime health unhealthy when model discovery fails', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error('HTTP 401: invalid token'));

    const site = await db.insert(schema.sites).values({
      name: 'site-fail',
      url: 'https://site-fail.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'fail-user',
      accessToken: '',
      apiToken: 'sk-invalid',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      modelCount: 0,
      modelsPreview: [],
      tokenScanned: 0,
      status: 'failed',
      errorCode: 'unauthorized',
    });

    const latest = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    const parsed = JSON.parse(latest!.extraConfig || '{}');
    expect(parsed.runtimeHealth?.state).toBe('unhealthy');
    expect(parsed.runtimeHealth?.source).toBe('model-discovery');
    expect(parsed.runtimeHealth?.reason).toBe('模型获取失败，API Key 已无效');
    expect(parsed.runtimeHealth?.checkedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('clears previous API-key coverage when model discovery is unauthorized', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error('HTTP 401: invalid token'));

    const site = await db.insert(schema.sites).values({
      name: 'site-invalid-apikey-coverage',
      url: 'https://site-invalid-apikey-coverage.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'invalid-apikey-coverage-user',
      accessToken: '',
      apiToken: 'sk-invalid',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'stale-default',
      token: 'sk-invalid',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-stale',
      available: true,
      checkedAt: '2026-03-21T11:30:00.000Z',
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-stale',
      available: true,
      checkedAt: '2026-03-21T11:30:00.000Z',
    }).run();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'unauthorized',
    });

    const modelRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(modelRows).toHaveLength(0);

    const tokenRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all();
    expect(tokenRows).toHaveLength(0);
  });

  it('normalizes anyrouter html challenge parse errors during model discovery', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error("Unexpected token '<', \"<html><scr\"... is not valid JSON"));

    const site = await db.insert(schema.sites).values({
      name: 'site-anyrouter',
      url: 'https://anyrouter.example.com',
      platform: 'anyrouter',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'shielded-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      modelCount: 0,
      modelsPreview: [],
      tokenScanned: 0,
      status: 'failed',
      errorCode: 'unknown',
      errorMessage: '模型获取失败：站点返回了防护页面，请在目标站点创建 API Key 后再同步模型',
    });

    const latest = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    const parsed = JSON.parse(latest!.extraConfig || '{}');
    expect(parsed.runtimeHealth?.reason).toBe('模型获取失败：站点返回了防护页面，请在目标站点创建 API Key 后再同步模型');
  });

  it('keeps shield guidance when challenge html arrives with http 403 discovery failure', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error('HTTP 403: <html><script>var arg1="abc123"</script></html>'));

    const site = await db.insert(schema.sites).values({
      name: 'site-anyrouter-403',
      url: 'https://anyrouter-403.example.com',
      platform: 'anyrouter',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'shielded-user-403',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'failed',
      errorCode: 'unauthorized',
      errorMessage: '模型获取失败：站点返回了防护页面，请在目标站点创建 API Key 后再同步模型',
    });
  });

  it('does not scan hidden managed tokens for direct apikey connections', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => (
      token === 'sk-direct-credential' ? ['gpt-4.1'] : ['legacy-should-not-be-used']
    ));

    const site = await db.insert(schema.sites).values({
      name: 'apikey-direct-site',
      url: 'https://apikey-direct.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'apikey-direct-user',
      accessToken: '',
      apiToken: 'sk-direct-credential',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const hiddenToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'legacy-hidden',
      token: 'sk-legacy-hidden',
      source: 'legacy',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      modelCount: 1,
      modelsPreview: ['gpt-4.1'],
      tokenScanned: 0,
      discoveredByCredential: true,
    });

    const tokenRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, hiddenToken.id))
      .all();
    expect(tokenRows).toHaveLength(0);
  });

  it('returns structured result when account missing', async () => {
    const result = await refreshModelsForAccount(9999);

    expect(result).toMatchObject({
      accountId: 9999,
      refreshed: false,
      status: 'failed',
      errorCode: 'account_not_found',
      errorMessage: '账号不存在',
      modelCount: 0,
      modelsPreview: [],
      reason: 'account_not_found',
    });
  });

  it('returns structured result when site disabled', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-disabled',
      url: 'https://site-disabled.example.com',
      platform: 'new-api',
      status: 'disabled',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'disabled-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: false,
      status: 'skipped',
      errorCode: 'site_disabled',
      errorMessage: '站点已禁用',
      modelCount: 0,
      modelsPreview: [],
      reason: 'site_disabled',
    });
  });

  it('returns structured result when account inactive', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-inactive',
      url: 'https://site-inactive.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'inactive-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'disabled',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: false,
      status: 'skipped',
      errorCode: 'adapter_or_status',
      errorMessage: '平台不可用或账号未激活',
      modelCount: 0,
      modelsPreview: [],
      reason: 'adapter_or_status',
    });
  });

  it('preserves existing availability when allowInactive refresh fails', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error('upstream unavailable'));

    const site = await db.insert(schema.sites).values({
      name: 'site-rebind-refresh',
      url: 'https://site-rebind-refresh.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rebind-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'disabled',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-stored-token',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 120,
      checkedAt: '2026-03-21T11:30:00.000Z',
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 90,
      checkedAt: '2026-03-21T11:30:00.000Z',
    }).run();

    const result = await refreshModelsForAccount(account.id, { allowInactive: true });

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'failed',
      modelCount: 0,
      discoveredByCredential: false,
    });

    const modelRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(modelRows).toHaveLength(1);
    expect(modelRows[0]).toMatchObject({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
    });

    const tokenRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      tokenId: token.id,
      modelName: 'gpt-4.1',
      available: true,
    });
  });

  it.each([
    ['HTTP 429 usage limit', 'HTTP 429: usage_limit_reached'],
    [
      'HTTP 403 insufficient balance',
      'HTTP 403: {"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}',
    ],
  ])('preserves active account availability and routes when model discovery is rate limited: %s', async (_caseName, failureMessage) => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error(failureMessage));

    const site = await db.insert(schema.sites).values({
      name: 'site-rate-limited-refresh',
      url: 'https://site-rate-limited-refresh.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rate-limited-user',
      accessToken: '',
      apiToken: 'sk-rate-limited-account',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-rate-limited-token',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 120,
      checkedAt: '2026-03-21T11:30:00.000Z',
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 90,
      checkedAt: '2026-03-21T11:30:00.000Z',
    }).run();

    const initialRebuild = await rebuildTokenRoutesFromAvailability();
    expect(initialRebuild.createdRoutes).toBeGreaterThan(0);
    expect(initialRebuild.createdChannels).toBeGreaterThan(0);

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'failed',
      modelCount: 0,
      errorCode: 'rate_limited',
    });

    const modelRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(modelRows.map((row) => row.modelName)).toEqual(['gpt-4.1']);

    const tokenRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all();
    expect(tokenRows.map((row) => row.modelName)).toEqual(['gpt-4.1']);

    await rebuildTokenRoutesFromAvailability();

    const routes = await db.select().from(schema.tokenRoutes).all();
    const channels = await db.select().from(schema.routeChannels).all();
    expect(routes.map((route) => route.modelPattern)).toContain('gpt-4.1');
    expect(channels.some((channel) => channel.accountId === account.id)).toBe(true);
  });

  it('preserves a managed token coverage when another token refresh succeeds and this one is rate limited', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, tokenValue: string) => {
      if (tokenValue === 'sk-refresh-success') return ['gpt-success-new'];
      if (tokenValue === 'sk-rate-limited-token') throw new Error('HTTP 429: usage_limit_reached');
      return [];
    });

    const site = await db.insert(schema.sites).values({
      name: 'site-partial-token-limit',
      url: 'https://site-partial-token-limit.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'partial-token-user',
      accessToken: '',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const successToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'success',
      token: 'sk-refresh-success',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    const limitedToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'limited',
      token: 'sk-rate-limited-token',
      source: 'manual',
      enabled: true,
      isDefault: false,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'gpt-success-old',
        available: true,
        latencyMs: 110,
        checkedAt: '2026-03-21T11:30:00.000Z',
      },
      {
        accountId: account.id,
        modelName: 'gpt-limited-old',
        available: true,
        latencyMs: 120,
        checkedAt: '2026-03-21T11:30:00.000Z',
      },
    ]).run();

    await db.insert(schema.tokenModelAvailability).values([
      {
        tokenId: successToken.id,
        modelName: 'gpt-success-old',
        available: true,
        latencyMs: 90,
        checkedAt: '2026-03-21T11:30:00.000Z',
      },
      {
        tokenId: limitedToken.id,
        modelName: 'gpt-limited-old',
        available: true,
        latencyMs: 95,
        checkedAt: '2026-03-21T11:30:00.000Z',
      },
    ]).run();

    const initialRebuild = await rebuildTokenRoutesFromAvailability();
    expect(initialRebuild.createdRoutes).toBeGreaterThan(0);
    expect(initialRebuild.createdChannels).toBeGreaterThan(0);

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      modelCount: 2,
      discoveredByCredential: false,
    });

    const successRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, successToken.id))
      .all();
    expect(successRows.map((row) => row.modelName)).toEqual(['gpt-success-new']);

    const limitedRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, limitedToken.id))
      .all();
    expect(limitedRows.map((row) => row.modelName)).toEqual(['gpt-limited-old']);

    const modelRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(modelRows.map((row) => row.modelName).sort()).toEqual(['gpt-limited-old', 'gpt-success-new']);

    await rebuildTokenRoutesFromAvailability();

    const limitedRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-limited-old'))
      .get();
    expect(limitedRoute).toBeTruthy();

    const channels = await db.select().from(schema.routeChannels).all();
    expect(channels.some((channel) => (
      channel.routeId === limitedRoute!.id
      && channel.accountId === account.id
      && channel.tokenId === limitedToken.id
    ))).toBe(true);
  });

  it.each(['rate-limited-first', 'invalid-first'] as const)(
    'does not restore unauthorized token coverage when all managed token refreshes fail with mixed errors: %s',
    async (tokenOrder) => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, tokenValue: string) => {
      if (tokenValue === 'session-access-token') return [];
      if (tokenValue === 'sk-rate-limited-token') throw new Error('HTTP 429: usage_limit_reached');
      if (tokenValue === 'sk-invalid-token') throw new Error('HTTP 401: invalid token');
      return [];
    });

    const site = await db.insert(schema.sites).values({
      name: 'site-mixed-token-failure',
      url: 'https://site-mixed-token-failure.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'mixed-token-failure-user',
      accessToken: 'session-access-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const limitedTokenValues = {
      accountId: account.id,
      name: 'limited',
      token: 'sk-rate-limited-token',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    };
    const invalidTokenValues = {
      accountId: account.id,
      name: 'invalid',
      token: 'sk-invalid-token',
      source: 'manual',
      enabled: true,
      isDefault: false,
      valueStatus: 'ready' as any,
    };
    const insertedTokens = await db.insert(schema.accountTokens).values(
      tokenOrder === 'invalid-first'
        ? [invalidTokenValues, limitedTokenValues]
        : [limitedTokenValues, invalidTokenValues],
    ).returning().all();
    const limitedToken = insertedTokens.find((token) => token.token === 'sk-rate-limited-token')!;
    const invalidToken = insertedTokens.find((token) => token.token === 'sk-invalid-token')!;

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'gpt-limited-old',
        available: true,
        checkedAt: '2026-03-21T11:30:00.000Z',
      },
      {
        accountId: account.id,
        modelName: 'gpt-invalid-old',
        available: true,
        checkedAt: '2026-03-21T11:30:00.000Z',
      },
    ]).run();

    await db.insert(schema.tokenModelAvailability).values([
      {
        tokenId: limitedToken.id,
        modelName: 'gpt-limited-old',
        available: true,
        checkedAt: '2026-03-21T11:30:00.000Z',
      },
      {
        tokenId: invalidToken.id,
        modelName: 'gpt-invalid-old',
        available: true,
        checkedAt: '2026-03-21T11:30:00.000Z',
      },
    ]).run();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'rate_limited',
    });

    const limitedRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, limitedToken.id))
      .all();
    expect(limitedRows.map((row) => row.modelName)).toEqual(['gpt-limited-old']);

    const invalidRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, invalidToken.id))
      .all();
    expect(invalidRows).toHaveLength(0);

    const modelRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(modelRows.map((row) => row.modelName)).toEqual(['gpt-limited-old']);
  });

  it('treats HTTP 429 usage-limit errors as rate limited even when the body mentions invalid_request_error', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error(`HTTP 429: ${JSON.stringify({
      status: 429,
      error: {
        type: 'invalid_request_error',
        code: 'usage_limit_reached',
        message: 'The usage limit has been reached',
      },
    })}`));

    const site = await db.insert(schema.sites).values({
      name: 'site-rate-limit-invalid-body',
      url: 'https://site-rate-limit-invalid-body.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rate-limit-invalid-body-user',
      accessToken: '',
      apiToken: 'sk-rate-limited',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-still-available',
      available: true,
      checkedAt: '2026-03-21T11:30:00.000Z',
    }).run();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'rate_limited',
      errorMessage: '模型获取失败：上游限额或频率限制',
    });

    const modelRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(modelRows.map((row) => row.modelName)).toEqual(['gpt-still-available']);
  });

  it('does not scan masked_pending placeholders as token credentials', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => (
      token === 'sk-mask***tail' ? ['gpt-5.2-codex'] : []
    ));

    const site = await db.insert(schema.sites).values({
      name: 'site-placeholder',
      url: 'https://site-placeholder.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'placeholder-user',
      accessToken: '',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const placeholder = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-token',
      token: 'sk-mask***tail',
      source: 'sync',
      enabled: true,
      isDefault: false,
      valueStatus: 'masked_pending' as any,
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'failed',
      tokenScanned: 0,
    });

    const placeholderModels = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, placeholder.id))
      .all();
    expect(placeholderModels).toEqual([]);
    expect(getModelsMock).not.toHaveBeenCalledWith(site.url, 'sk-mask***tail', account.username);
  });

  it('preserves manual models after successful model refresh', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockResolvedValue(['gpt-4.1', 'claude-opus-4-6']);

    const site = await db.insert(schema.sites).values({
      name: 'site-manual',
      url: 'https://site-manual.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'manual-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    // Add a manual model before refresh
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'my-custom-model',
      available: true,
      isManual: true,
    }).run();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
    });

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();

    const modelNames = rows.map((r) => r.modelName).sort();
    expect(modelNames).toContain('my-custom-model');
    expect(modelNames).toContain('gpt-4.1');
    expect(modelNames).toContain('claude-opus-4-6');

    const manualRow = rows.find((r) => r.modelName === 'my-custom-model');
    expect(manualRow?.isManual).toBe(true);
  });

  it('preserves manual models even when discovered models overlap', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockResolvedValue(['gpt-4.1', 'my-custom-model']);

    const site = await db.insert(schema.sites).values({
      name: 'site-overlap',
      url: 'https://site-overlap.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'overlap-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    // Manual model that also exists upstream
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'my-custom-model',
      available: true,
      isManual: true,
    }).run();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
    });

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();

    // Should have gpt-4.1 (discovered) and my-custom-model (manual, kept as-is)
    const modelNames = rows.map((r) => r.modelName).sort();
    expect(modelNames).toEqual(['gpt-4.1', 'my-custom-model']);

    // The manual model should still have isManual=true (not overwritten by discovery)
    const manualRow = rows.find((r) => r.modelName === 'my-custom-model');
    expect(manualRow?.isManual).toBe(true);
  });

  it('preserves manual models when refresh fails and restores previous availability', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockResolvedValue([]);

    const site = await db.insert(schema.sites).values({
      name: 'site-fail',
      url: 'https://site-fail.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'fail-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    // Existing synced model
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      isManual: false,
    }).run();

    // Manual model
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'my-custom-model',
      available: true,
      isManual: true,
    }).run();

    const result = await refreshModelsForAccount(account.id, { allowInactive: true });

    expect(result).toMatchObject({
      status: 'failed',
    });

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();

    // Both manual model and restored synced model should exist
    const modelNames = rows.map((r) => r.modelName).sort();
    expect(modelNames).toContain('my-custom-model');
    expect(modelNames).toContain('gpt-4.1');

    const manualRow = rows.find((r) => r.modelName === 'my-custom-model');
    expect(manualRow?.isManual).toBe(true);
  });

});
