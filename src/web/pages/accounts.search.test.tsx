import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    batchUpdateAccounts: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function hasAccountRow(root: WebTestRenderer, accountId: number) {
  return root.root.findAll(
    (node) => node.props['data-testid'] === `account-row-${accountId}`,
  ).length > 0;
}

describe('Accounts keyword search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Alpha Gateway', platform: 'new-api', status: 'active' },
      { id: 20, name: 'Claude Hub', platform: 'sub2api', status: 'active' },
    ]);
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 101,
        siteId: 10,
        username: 'alice@example.com',
        accessToken: 'session-alice',
        status: 'active',
        runtimeHealth: { state: 'healthy', reason: '最近检查成功' },
        site: {
          id: 10,
          name: 'Alpha Gateway',
          platform: 'new-api',
          status: 'active',
          url: 'https://alpha.example.com',
        },
      },
      {
        id: 202,
        siteId: 20,
        username: 'bob@example.com',
        accessToken: 'session-bob',
        status: 'expired',
        runtimeHealth: { state: 'unhealthy', reason: '凭证失效' },
        site: {
          id: 20,
          name: 'Claude Hub',
          platform: 'sub2api',
          status: 'active',
          url: 'https://claude.example.com',
        },
      },
    ]);
    apiMock.batchUpdateAccounts.mockResolvedValue({
      success: true,
      successIds: [101],
      failedItems: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['account name', 'alice@example.com', 101],
    ['site', 'claude hub', 202],
    ['localized status', '已过期', 202],
    ['account id', '101', 101],
  ])('filters desktop rows by %s', async (_label, query, expectedId) => {
    let root!: WebTestRenderer;
    try {
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

      const searchInput = root.root.find(
        (node) => node.props['data-testid'] === 'accounts-search',
      );
      await act(async () => {
        searchInput.props.onChange({ target: { value: query } });
      });

      expect(hasAccountRow(root, expectedId)).toBe(true);
      expect(hasAccountRow(root, expectedId === 101 ? 202 : 101)).toBe(false);
    } finally {
      root?.unmount();
    }
  });

  it('limits select-all and batch actions to the filtered visible rows', async () => {
    let root!: WebTestRenderer;
    try {
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

      const hiddenSelection = root.root.find(
        (node) => node.props['data-testid'] === 'account-select-202',
      );
      await act(async () => {
        hiddenSelection.props.onChange({ target: { checked: true } });
      });

      const searchInput = root.root.find(
        (node) => node.props['data-testid'] === 'accounts-search',
      );
      await act(async () => {
        searchInput.props.onChange({ target: { value: 'alice' } });
      });

      const selectAll = root.root.find(
        (node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props['data-testid'],
      );
      await act(async () => {
        selectAll.props.onChange({ target: { checked: true } });
      });

      const batchButton = root.root.find(
        (node) => node.props['data-testid'] === 'accounts-batch-refresh-balance',
      );
      await act(async () => {
        batchButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateAccounts).toHaveBeenCalledWith({
        ids: [101],
        action: 'refreshBalance',
      });
    } finally {
      root?.unmount();
    }
  });

  it('keeps the confirmed batch-delete targets stable when the search changes', async () => {
    let root!: WebTestRenderer;
    try {
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

      const aliceSelection = root.root.find(
        (node) => node.props['data-testid'] === 'account-select-101',
      );
      const bobSelection = root.root.find(
        (node) => node.props['data-testid'] === 'account-select-202',
      );
      await act(async () => {
        aliceSelection.props.onChange({ target: { checked: true } });
        bobSelection.props.onChange({ target: { checked: true } });
      });

      let searchInput = root.root.find(
        (node) => node.props['data-testid'] === 'accounts-search',
      );
      await act(async () => {
        searchInput.props.onChange({ target: { value: 'alice' } });
      });

      const batchDeleteButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => node.children.some((child) => child === '批量删除'));
      expect(batchDeleteButton).toBeTruthy();
      await act(async () => {
        batchDeleteButton!.props.onClick();
      });
      await flushMicrotasks();

      searchInput = root.root.find(
        (node) => node.props['data-testid'] === 'accounts-search',
      );
      await act(async () => {
        searchInput.props.onChange({ target: { value: 'bob' } });
      });

      const confirmButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => node.children.some((child) => child === '确认删除'));
      expect(confirmButton).toBeTruthy();
      await act(async () => {
        confirmButton!.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateAccounts).toHaveBeenCalledWith({
        ids: [101],
        action: 'delete',
      });
    } finally {
      root?.unmount();
    }
  });
});
