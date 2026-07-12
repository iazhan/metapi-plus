import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshSub2ApiManagedSessionMock = vi.fn();

vi.mock('./sub2apiManagedAuth.js', () => ({
  refreshSub2ApiManagedSession: (...args: unknown[]) => refreshSub2ApiManagedSessionMock(...args),
}));

describe('sub2apiRefreshSingleflight', () => {
  beforeEach(async () => {
    refreshSub2ApiManagedSessionMock.mockReset();
    const { __resetSub2ApiManagedRefreshSingleflightForTests } = await import('./sub2apiRefreshSingleflight.js');
    __resetSub2ApiManagedRefreshSingleflightForTests();
  });

  it('coalesces concurrent refreshes for the same account id', async () => {
    let resolveRefresh: ((value: { accessToken: string; extraConfig: string }) => void) | null = null;
    refreshSub2ApiManagedSessionMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const { refreshSub2ApiManagedSessionSingleflight } = await import('./sub2apiRefreshSingleflight.js');

    const params = {
      account: { id: 42 } as { id: number },
      site: { id: 7, platform: 'sub2api', url: 'https://sub2.example.com' } as {
        id: number;
        platform: string;
        url: string;
      },
      currentAccessToken: 'stale-access-token',
      currentExtraConfig: '{"sub2apiAuth":{"refreshToken":"refresh-token"}}',
    };

    const first = refreshSub2ApiManagedSessionSingleflight(params as never);
    const second = refreshSub2ApiManagedSessionSingleflight(params as never);

    expect(refreshSub2ApiManagedSessionMock).toHaveBeenCalledTimes(1);

    resolveRefresh?.({
      accessToken: 'fresh-access-token',
      extraConfig: '{"sub2apiAuth":{"refreshToken":"next-refresh-token"}}',
    });

    await expect(first).resolves.toEqual({
      accessToken: 'fresh-access-token',
      extraConfig: '{"sub2apiAuth":{"refreshToken":"next-refresh-token"}}',
    });
    await expect(second).resolves.toEqual({
      accessToken: 'fresh-access-token',
      extraConfig: '{"sub2apiAuth":{"refreshToken":"next-refresh-token"}}',
    });
  });

  it('cleans up in-flight state after a rejected refresh so the next attempt can retry', async () => {
    let rejectRefresh: ((error: Error) => void) | null = null;
    refreshSub2ApiManagedSessionMock.mockImplementation(
      () => new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      }),
    );

    const { refreshSub2ApiManagedSessionSingleflight } = await import('./sub2apiRefreshSingleflight.js');

    const params = {
      account: { id: 42 } as { id: number },
      site: { id: 7, platform: 'sub2api', url: 'https://sub2.example.com' } as {
        id: number;
        platform: string;
        url: string;
      },
      currentAccessToken: 'stale-access-token',
      currentExtraConfig: '{"sub2apiAuth":{"refreshToken":"refresh-token"}}',
    };

    const first = refreshSub2ApiManagedSessionSingleflight(params as never);
    const second = refreshSub2ApiManagedSessionSingleflight(params as never);

    expect(refreshSub2ApiManagedSessionMock).toHaveBeenCalledTimes(1);

    rejectRefresh?.(new Error('refresh rejected'));

    await expect(first).rejects.toThrow('refresh rejected');
    await expect(second).rejects.toThrow('refresh rejected');

    refreshSub2ApiManagedSessionMock.mockResolvedValueOnce({
      accessToken: 'fresh-access-token',
      extraConfig: '{"sub2apiAuth":{"refreshToken":"next-refresh-token"}}',
    });

    await expect(refreshSub2ApiManagedSessionSingleflight(params as never)).resolves.toEqual({
      accessToken: 'fresh-access-token',
      extraConfig: '{"sub2apiAuth":{"refreshToken":"next-refresh-token"}}',
    });
    expect(refreshSub2ApiManagedSessionMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the shared refresh active when the first waiter cancels', async () => {
    let resolveRefresh!: (value: { accessToken: string; extraConfig: string }) => void;
    let operationSignal: AbortSignal | undefined;
    refreshSub2ApiManagedSessionMock.mockImplementation((input: { signal?: AbortSignal }) => {
      operationSignal = input.signal;
      return new Promise((resolve) => { resolveRefresh = resolve; });
    });
    const { refreshSub2ApiManagedSessionSingleflight } = await import('./sub2apiRefreshSingleflight.js');
    const params = {
      account: { id: 43 },
      site: { id: 7, platform: 'sub2api', url: 'https://sub2.example.com' },
      currentAccessToken: 'stale-access-token',
      currentExtraConfig: '{"sub2apiAuth":{"refreshToken":"refresh-token"}}',
    };
    const firstOwner = new AbortController();
    const secondOwner = new AbortController();

    const first = refreshSub2ApiManagedSessionSingleflight({ ...params, signal: firstOwner.signal } as never);
    const second = refreshSub2ApiManagedSessionSingleflight({ ...params, signal: secondOwner.signal } as never);
    firstOwner.abort(new DOMException('first owner cancelled', 'AbortError'));

    await expect(first).rejects.toMatchObject({ name: 'AbortError', message: 'first owner cancelled' });
    expect(operationSignal).toBeInstanceOf(AbortSignal);
    expect(operationSignal).not.toBe(firstOwner.signal);
    expect(operationSignal?.aborted).toBe(false);

    resolveRefresh({ accessToken: 'fresh-token', extraConfig: '{}' });
    await expect(second).resolves.toMatchObject({ accessToken: 'fresh-token' });
    expect(refreshSub2ApiManagedSessionMock).toHaveBeenCalledTimes(1);
  });

  it('releases an abandoned refresh generation and ignores its late settlement', async () => {
    const resolvers: Array<(value: { accessToken: string; extraConfig: string }) => void> = [];
    const operationSignals: AbortSignal[] = [];
    refreshSub2ApiManagedSessionMock.mockImplementation((input: { signal?: AbortSignal }) => {
      if (input.signal) operationSignals.push(input.signal);
      return new Promise((resolve) => { resolvers.push(resolve); });
    });
    const { refreshSub2ApiManagedSessionSingleflight } = await import('./sub2apiRefreshSingleflight.js');
    const params = {
      account: { id: 44 },
      site: { id: 7, platform: 'sub2api', url: 'https://sub2.example.com' },
      currentAccessToken: 'stale-access-token',
      currentExtraConfig: '{"sub2apiAuth":{"refreshToken":"refresh-token"}}',
    };
    const abandonedOwner = new AbortController();

    const abandoned = refreshSub2ApiManagedSessionSingleflight({
      ...params,
      signal: abandonedOwner.signal,
    } as never);
    abandonedOwner.abort(new DOMException('abandon first generation', 'AbortError'));
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    expect(operationSignals[0]?.aborted).toBe(true);

    const fresh = refreshSub2ApiManagedSessionSingleflight(params as never);
    expect(refreshSub2ApiManagedSessionMock).toHaveBeenCalledTimes(2);
    resolvers[0]?.({ accessToken: 'stale-token', extraConfig: '{}' });
    await Promise.resolve();

    const joinedFresh = refreshSub2ApiManagedSessionSingleflight(params as never);
    expect(refreshSub2ApiManagedSessionMock).toHaveBeenCalledTimes(2);
    resolvers[1]?.({ accessToken: 'fresh-token', extraConfig: '{}' });
    await expect(Promise.all([fresh, joinedFresh])).resolves.toEqual([
      expect.objectContaining({ accessToken: 'fresh-token' }),
      expect.objectContaining({ accessToken: 'fresh-token' }),
    ]);
  });
});
