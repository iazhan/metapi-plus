import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ProxyTestRequestEnvelope } from './api.js';
import { persistAuthSession } from './authSession.js';

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
}

function installPendingFetch() {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api proxy test timeout handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', createMemoryStorage());
    persistAuthSession(globalThis.localStorage as Storage, 'token-1');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps image generation proxy tests alive past the default 30 second timeout', async () => {
    installPendingFetch();

    const payload: ProxyTestRequestEnvelope = {
      method: 'POST',
      path: '/v1/images/generations',
      requestKind: 'json',
      jsonBody: {
        model: 'gemini-imagen',
        prompt: 'banana cat',
      },
    };

    let settled = false;
    const promise = api.proxyTest(payload);
    const handled = promise
      .then(() => ({ ok: true as const }))
      .catch((error: Error) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    const result = await handled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected image generation proxy test to time out');
    }
    expect(result.error.message).toBe('请求超时（150s）');
  });

  it('still uses the default 30 second timeout for generic proxy tests', async () => {
    installPendingFetch();

    const payload: ProxyTestRequestEnvelope = {
      method: 'POST',
      path: '/v1/embeddings',
      requestKind: 'json',
      jsonBody: {
        model: 'text-embedding-3-small',
        input: 'hello',
      },
    };

    const promise = api.proxyTest(payload).catch((error: Error) => error);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toMatchObject({ message: '请求超时（30s）' });
  });

  it('keeps account password login alive for the full 90 second sync window', async () => {
    installPendingFetch();

    let settled = false;
    const handled = api.loginAccount({
      siteId: 1,
      username: 'demo-user',
      password: 'password',
    })
      .then(() => ({ ok: true as const }))
      .catch((error: Error) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    const result = await handled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected account login to time out');
    }
    expect(result.error.message).toBe('请求超时（90s）');
  });

  it('keeps single-account token sync alive beyond the 45 second server worst path', async () => {
    installPendingFetch();

    let settled = false;
    const handled = api.syncAccountTokens(1)
      .then(() => ({ ok: true as const }))
      .catch((error: Error) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await handled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected single-account token sync to time out');
    }
    expect(result.error.message).toBe('请求超时（75s）');
  });

  it('keeps an immediate account rate refresh alive past the default timeout', async () => {
    installPendingFetch();

    let settled = false;
    const handled = api.refreshAccountGroupRates()
      .then(() => ({ ok: true as const }))
      .catch((error: Error) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    const result = await handled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected account rate refresh to time out');
    }
    expect(result.error.message).toBe('请求超时（150s）');
  });

  it('keeps all-model site probes alive past the default 30 second timeout', async () => {
    installPendingFetch();

    let settled = false;
    const promise = api.probeSiteNow(1, { scope: 'all' });
    const handled = promise
      .then(() => ({ ok: true as const }))
      .catch((error: Error) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(90_000);
    const result = await handled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected all-model site probe to time out');
    }
    expect(result.error.message).toBe('请求超时（120s）');
  });

  it('times out replay hydration file-content fetches after 30 seconds', async () => {
    installPendingFetch();

    const getProxyFileContentDataUrl = (api as Record<string, any>).getProxyFileContentDataUrl;
    let settled = false;
    const handled = getProxyFileContentDataUrl?.('file-metapi-123')
      .then(() => ({ ok: true as const }))
      .catch((error: Error) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(true);

    const result = await handled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected replay hydration file-content fetch to time out');
    }
    expect(result.error.message).toBe('请求超时（30s）');
  });

  it('loads proxy file content as a data URL for replay hydration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      new Blob([Buffer.from('PDF')], { type: 'application/pdf' }),
      {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'inline; filename="brief.pdf"',
        },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const getProxyFileContentDataUrl = (api as Record<string, any>).getProxyFileContentDataUrl;
    const result = await getProxyFileContentDataUrl?.('file-metapi-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/files/file-metapi-123/content');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe('GET');
    expect(init?.headers).toBeInstanceOf(Headers);
    expect((init?.headers as Headers).get('Authorization')).toBe('Bearer token-1');
    expect(result).toEqual({
      filename: 'brief.pdf',
      mimeType: 'application/pdf',
      data: 'data:application/pdf;base64,UERG',
    });
  });

  it('reuses the same proxy test implementations for legacy aliases', () => {
    expect(api.proxyTest).toBe(api.testProxy);
    expect(api.proxyTestStream).toBe(api.testProxyStream);
  });

  it('encodes pricing model ids and group keys exactly once', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await api.saveSiteModelPriceRule(7, 'openai/gpt-4.1 mini/2025', {
      mappingMode: 'custom',
    });
    await api.saveAccountGroupRateRule(9, 'pro/team', 0);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/sites/7/pricing/models/openai%2Fgpt-4.1%20mini%2F2025/rule',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/accounts/9/group-rates/pro%2Fteam/rule',
    );
  });

  it('sends proxy context with site detection requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ platform: 'new-api' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await api.detectSite('https://proxy-detect.example.com', {
      proxyUrl: 'socks5h://proxy-user:proxy-secret@127.0.0.1:1080',
      useSystemProxy: true,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sites/detect');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      url: 'https://proxy-detect.example.com',
      proxyUrl: 'socks5h://proxy-user:proxy-secret@127.0.0.1:1080',
      useSystemProxy: true,
    });
  });

  it('requests an immediate account group rate refresh', async () => {
    const responseBody = {
      success: true,
      result: {
        scanned: 4,
        candidates: 3,
        synced: 2,
        skipped: 1,
        deferred: 0,
        failed: 1,
        recovered: 0,
        durationMs: 80,
      },
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(responseBody),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.refreshAccountGroupRates()).resolves.toEqual(responseBody);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/settings/account-group-rates/refresh');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
  });
});
