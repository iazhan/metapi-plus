import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  login: vi.fn(),
};
const decryptPasswordMock = vi.fn();
const persistRecoveredSessionMock = vi.fn();
const refreshSub2ApiSessionMock = vi.fn();

vi.mock('../db/index.js', () => ({ schema: { accounts: {} } }));

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => adapterMock,
}));

vi.mock('./accountCredentialService.js', () => ({
  decryptAccountPassword: (...args: unknown[]) => decryptPasswordMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  withAccountProxyOverride: (_proxyUrl: string | null, operation: () => unknown) => operation(),
}));

vi.mock('./accountSessionPersistenceService.js', () => ({
  persistRecoveredAccountSession: (...args: unknown[]) => persistRecoveredSessionMock(...args),
}));

vi.mock('./sub2apiRefreshSingleflight.js', () => ({
  refreshSub2ApiManagedSessionSingleflight: (...args: unknown[]) => refreshSub2ApiSessionMock(...args),
}));

describe('accountLoginSessionService', () => {
  beforeEach(async () => {
    adapterMock.login.mockReset();
    decryptPasswordMock.mockReset();
    persistRecoveredSessionMock.mockReset();
    refreshSub2ApiSessionMock.mockReset();
    persistRecoveredSessionMock.mockImplementation(async (input: any) => ({
      account: input.account,
      accessToken: input.accessToken,
      extraConfig: input.mergeExtraConfig(input.account.extraConfig ?? null),
    }));
    const service = await import('./accountLoginSessionService.js');
    service.__resetAccountReloginSingleflightForTests();
  });

  it('merges normalized login metadata without dropping existing account config', async () => {
    const { mergeLoginSessionMetadata } = await import('./accountLoginSessionService.js');

    const merged = mergeLoginSessionMetadata(
      JSON.stringify({ keep: 'value', credentialMode: 'session' }),
      'sub2api',
      {
        success: true,
        accessToken: 'access-token',
        platformUserId: 42,
        refreshToken: 'refresh-token',
        expiresAt: 1_800_000,
      },
    );

    expect(JSON.parse(merged)).toEqual({
      keep: 'value',
      credentialMode: 'session',
      platformUserId: 42,
      sub2apiAuth: {
        refreshToken: 'refresh-token',
        tokenExpiresAt: 1_800_000,
      },
    });
  });

  it('persists complete login metadata when relogging an account', async () => {
    decryptPasswordMock.mockReturnValue('plain-password');
    adapterMock.login.mockResolvedValue({
      success: true,
      accessToken: 'fresh-token',
      platformUserId: 7788,
    });
    const account = {
      id: 7,
      status: 'expired',
      username: 'person@example.com',
      extraConfig: JSON.stringify({
        autoRelogin: { username: 'person@example.com', passwordCipher: 'cipher' },
      }),
    } as any;
    const site = {
      url: 'https://newapi.example.com',
      platform: 'new-api',
    } as any;

    const { reloginAccountSession } = await import('./accountLoginSessionService.js');
    const result = await reloginAccountSession(account, site);

    expect(result).toMatchObject({ accessToken: 'fresh-token', platformUserId: 7788 });
    expect(persistRecoveredSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      account,
      accessToken: 'fresh-token',
      mergeExtraConfig: expect.any(Function),
    }));
    const persistenceInput = persistRecoveredSessionMock.mock.calls[0]?.[0] as any;
    expect(JSON.parse(String(persistenceInput.mergeExtraConfig(account.extraConfig))))
      .toMatchObject({ platformUserId: 7788 });
  });

  it('coalesces concurrent relogin attempts for the same account', async () => {
    decryptPasswordMock.mockReturnValue('plain-password');
    let resolveLogin!: (value: unknown) => void;
    adapterMock.login.mockReturnValue(new Promise((resolve) => {
      resolveLogin = resolve;
    }));
    const account = {
      id: 9,
      status: 'active',
      username: 'person@example.com',
      extraConfig: JSON.stringify({
        autoRelogin: { username: 'person@example.com', passwordCipher: 'cipher' },
      }),
    } as any;
    const site = { url: 'https://newapi.example.com', platform: 'new-api' } as any;

    const { reloginAccountSession } = await import('./accountLoginSessionService.js');
    const first = reloginAccountSession(account, site);
    const second = reloginAccountSession(account, site);
    expect(adapterMock.login).toHaveBeenCalledTimes(1);

    resolveLogin({ success: true, accessToken: 'single-token' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ accessToken: 'single-token' }),
      expect.objectContaining({ accessToken: 'single-token' }),
    ]);
    expect(adapterMock.login).toHaveBeenCalledTimes(1);
  });

  it('recovers a managed Sub2API session through the refresh-token singleflight first', async () => {
    const extraConfig = JSON.stringify({
      credentialMode: 'session',
      platformUserId: 42,
      sub2apiAuth: { refreshToken: 'stored-refresh-token' },
    });
    const refreshedExtraConfig = JSON.stringify({
      credentialMode: 'session',
      platformUserId: 42,
      sub2apiAuth: { refreshToken: 'rotated-refresh-token' },
    });
    const account = {
      id: 10,
      status: 'active',
      username: 'sub2-user',
      accessToken: 'expired-access-token',
      extraConfig,
    } as any;
    const site = { url: 'https://sub2.example.com', platform: 'sub2api' } as any;
    refreshSub2ApiSessionMock.mockResolvedValue({
      accessToken: 'fresh-access-token',
      extraConfig: refreshedExtraConfig,
    });

    const { recoverAccountSession } = await import('./accountLoginSessionService.js');
    await expect(recoverAccountSession(account, site)).resolves.toEqual({
      accessToken: 'fresh-access-token',
      extraConfig: refreshedExtraConfig,
      platformUserId: 42,
    });
    expect(refreshSub2ApiSessionMock).toHaveBeenCalledTimes(1);
    expect(adapterMock.login).not.toHaveBeenCalled();
  });

  it('settles a never-resolving password login when its owner aborts', async () => {
    decryptPasswordMock.mockReturnValue('plain-password');
    let operationSignal: AbortSignal | undefined;
    adapterMock.login.mockImplementation((
      _baseUrl: string,
      _username: string,
      _password: string,
      signal?: AbortSignal,
    ) => {
      operationSignal = signal;
      return new Promise(() => {});
    });
    const account = {
      id: 11,
      username: 'person@example.com',
      extraConfig: JSON.stringify({
        autoRelogin: { username: 'person@example.com', passwordCipher: 'cipher' },
      }),
    } as any;
    const site = { url: 'https://newapi.example.com', platform: 'new-api' } as any;
    const controller = new AbortController();

    const { recoverAccountSession } = await import('./accountLoginSessionService.js');
    const pending = recoverAccountSession(account, site, { signal: controller.signal });
    expect(operationSignal).toBeInstanceOf(AbortSignal);
    expect(operationSignal).not.toBe(controller.signal);
    controller.abort(new DOMException('owner cancelled login', 'AbortError'));

    await expect(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('login did not settle')), 25)),
    ])).rejects.toMatchObject({ name: 'AbortError', message: 'owner cancelled login' });
    expect(operationSignal?.aborted).toBe(true);
  });

  it('keeps a joined password relogin active when the first waiter cancels', async () => {
    decryptPasswordMock.mockReturnValue('plain-password');
    let resolveLogin!: (value: unknown) => void;
    let operationSignal: AbortSignal | undefined;
    adapterMock.login.mockImplementation((
      _baseUrl: string,
      _username: string,
      _password: string,
      signal?: AbortSignal,
    ) => {
      operationSignal = signal;
      return new Promise((resolve) => { resolveLogin = resolve; });
    });
    const account = {
      id: 13,
      username: 'person@example.com',
      extraConfig: JSON.stringify({
        autoRelogin: { username: 'person@example.com', passwordCipher: 'cipher' },
      }),
    } as any;
    const site = { url: 'https://newapi.example.com', platform: 'new-api' } as any;
    const firstOwner = new AbortController();
    const secondOwner = new AbortController();

    const { reloginAccountSession } = await import('./accountLoginSessionService.js');
    const first = reloginAccountSession(account, site, { signal: firstOwner.signal });
    const second = reloginAccountSession(account, site, { signal: secondOwner.signal });
    firstOwner.abort(new DOMException('first owner cancelled', 'AbortError'));

    await expect(first).rejects.toMatchObject({ name: 'AbortError', message: 'first owner cancelled' });
    expect(operationSignal?.aborted).toBe(false);
    expect(adapterMock.login).toHaveBeenCalledTimes(1);

    resolveLogin({ success: true, accessToken: 'second-owner-token' });
    await expect(second).resolves.toMatchObject({ accessToken: 'second-owner-token' });
  });

  it('observes owner cancellation that happens while the shared login starts', async () => {
    decryptPasswordMock.mockReturnValue('plain-password');
    const owner = new AbortController();
    adapterMock.login.mockImplementation(() => {
      owner.abort(new DOMException('cancelled during start', 'AbortError'));
      return new Promise(() => {});
    });
    const account = {
      id: 16,
      username: 'person@example.com',
      extraConfig: JSON.stringify({
        autoRelogin: { username: 'person@example.com', passwordCipher: 'cipher' },
      }),
    } as any;
    const site = { url: 'https://newapi.example.com', platform: 'new-api' } as any;

    const { reloginAccountSession } = await import('./accountLoginSessionService.js');
    const pending = reloginAccountSession(account, site, { signal: owner.signal });

    await expect(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('start cancellation was missed')), 25)),
    ])).rejects.toMatchObject({ name: 'AbortError', message: 'cancelled during start' });
  });

  it('releases an abandoned password generation and ignores its late settlement', async () => {
    decryptPasswordMock.mockReturnValue('plain-password');
    const resolvers: Array<(value: unknown) => void> = [];
    const operationSignals: AbortSignal[] = [];
    adapterMock.login.mockImplementation((
      _baseUrl: string,
      _username: string,
      _password: string,
      signal?: AbortSignal,
    ) => {
      if (signal) operationSignals.push(signal);
      return new Promise((resolve) => { resolvers.push(resolve); });
    });
    const account = {
      id: 14,
      username: 'person@example.com',
      extraConfig: JSON.stringify({
        autoRelogin: { username: 'person@example.com', passwordCipher: 'cipher' },
      }),
    } as any;
    const site = { url: 'https://newapi.example.com', platform: 'new-api' } as any;
    const abandonedOwner = new AbortController();

    const { reloginAccountSession } = await import('./accountLoginSessionService.js');
    const abandoned = reloginAccountSession(account, site, { signal: abandonedOwner.signal });
    abandonedOwner.abort(new DOMException('abandon first generation', 'AbortError'));
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    expect(operationSignals[0]?.aborted).toBe(true);

    const fresh = reloginAccountSession(account, site);
    expect(adapterMock.login).toHaveBeenCalledTimes(2);
    resolvers[0]?.({ success: true, accessToken: 'stale-token' });
    await Promise.resolve();

    const joinedFresh = reloginAccountSession(account, site);
    expect(adapterMock.login).toHaveBeenCalledTimes(2);
    resolvers[1]?.({ success: true, accessToken: 'fresh-token' });
    await expect(Promise.all([fresh, joinedFresh])).resolves.toEqual([
      expect.objectContaining({ accessToken: 'fresh-token' }),
      expect.objectContaining({ accessToken: 'fresh-token' }),
    ]);
  });

  it('settles a never-resolving managed refresh on abort without password fallback', async () => {
    refreshSub2ApiSessionMock.mockReturnValue(new Promise(() => {}));
    decryptPasswordMock.mockReturnValue('plain-password');
    const account = {
      id: 12,
      username: 'sub2-user',
      accessToken: 'expired-access-token',
      extraConfig: JSON.stringify({
        sub2apiAuth: { refreshToken: 'stored-refresh-token' },
        autoRelogin: { username: 'sub2-user', passwordCipher: 'cipher' },
      }),
    } as any;
    const site = { url: 'https://sub2.example.com', platform: 'sub2api' } as any;
    const controller = new AbortController();

    const { recoverAccountSession } = await import('./accountLoginSessionService.js');
    const pending = recoverAccountSession(account, site, { signal: controller.signal });
    controller.abort(new DOMException('owner cancelled refresh', 'AbortError'));

    await expect(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('refresh did not settle')), 25)),
    ])).rejects.toMatchObject({ name: 'AbortError', message: 'owner cancelled refresh' });
    expect(adapterMock.login).not.toHaveBeenCalled();
  });

  it('does not password-fallback when managed refresh aborts independently of an active owner', async () => {
    refreshSub2ApiSessionMock.mockRejectedValue(
      new DOMException('shared refresh aborted', 'AbortError'),
    );
    decryptPasswordMock.mockReturnValue('plain-password');
    const account = {
      id: 15,
      username: 'sub2-user',
      accessToken: 'expired-access-token',
      extraConfig: JSON.stringify({
        sub2apiAuth: { refreshToken: 'stored-refresh-token' },
        autoRelogin: { username: 'sub2-user', passwordCipher: 'cipher' },
      }),
    } as any;
    const site = { url: 'https://sub2.example.com', platform: 'sub2api' } as any;
    const activeOwner = new AbortController();

    const { recoverAccountSession } = await import('./accountLoginSessionService.js');
    await expect(recoverAccountSession(account, site, { signal: activeOwner.signal }))
      .rejects.toMatchObject({ name: 'AbortError', message: 'shared refresh aborted' });
    expect(activeOwner.signal.aborted).toBe(false);
    expect(adapterMock.login).not.toHaveBeenCalled();
  });
});
