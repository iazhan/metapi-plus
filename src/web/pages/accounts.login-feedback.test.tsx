import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import ModernSelect from '../components/ModernSelect.js';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    loginAccount: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => (
    typeof child === 'string' ? child : collectText(child)
  )).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderAndSubmitLogin() {
  let root!: WebTestRenderer;
  await act(async () => {
    root = create(
      <MemoryRouter initialEntries={['/accounts']}>
        <ToastProvider>
          <Accounts />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flushMicrotasks();

  const addButton = root.root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && typeof node.props.className === 'string'
    && node.props.className.includes('btn btn-primary')
  ));
  await act(async () => {
    addButton.props.onClick();
  });

  const passwordLoginTab = root.root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).trim() === '账号密码登录'
  ));
  await act(async () => {
    passwordLoginTab.props.onClick();
  });

  const selects = root.root.findAllByType(ModernSelect);
  await act(async () => {
    selects[1]!.props.onChange('10');
  });

  const usernameInput = root.root.find((node) => node.type === 'input' && node.props.placeholder === '用户名');
  const passwordInput = root.root.find((node) => node.type === 'input' && node.props.placeholder === '密码');
  await act(async () => {
    usernameInput.props.onChange({ target: { value: 'demo-user' } });
    passwordInput.props.onChange({ target: { value: 'password' } });
  });

  const submitButton = root.root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).trim() === '登录并添加'
  ));
  await act(async () => {
    await submitButton.props.onClick();
  });
  await flushMicrotasks();
  return root;
}

describe('Accounts password-login synchronization feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
    apiMock.getAccounts.mockResolvedValue([]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Demo Site', platform: 'new-api', status: 'active' },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports a partial success when the account is saved but token sync fails', async () => {
    apiMock.loginAccount.mockResolvedValueOnce({
      success: true,
      apiTokenFound: false,
      tokenCount: 0,
      tokenSync: {
        status: 'failed',
        reason: 'sync_error',
        message: 'token down',
      },
      rateSync: { status: 'synced', total: 1, syncedAt: '2026-07-10T00:00:00.000Z' },
    });

    const root = await renderAndSubmitLogin();
    try {
      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('账号 \\"demo-user\\" 已添加，但令牌同步失败：token down');
      expect(rendered).not.toContain('未找到 API Key，请手动设置');
    } finally {
      root.unmount();
    }
  });

  it('reports a rate warning after token sync succeeds', async () => {
    apiMock.loginAccount.mockResolvedValueOnce({
      success: true,
      apiTokenFound: true,
      tokenCount: 1,
      tokenSync: { status: 'synced' },
      rateSync: { status: 'failed', message: 'rate down' },
    });

    const root = await renderAndSubmitLogin();
    try {
      expect(JSON.stringify(root.toJSON())).toContain(
        '账号 \\"demo-user\\" 已添加，API Key 已自动获取，但倍率同步失败：rate down',
      );
    } finally {
      root.unmount();
    }
  });
});
