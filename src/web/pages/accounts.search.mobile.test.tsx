import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(node: ReactTestInstance): string {
  return (node.children || [])
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');
}

describe('Accounts mobile keyword search', () => {
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
        site: { id: 10, name: 'Alpha Gateway', platform: 'new-api', status: 'active' },
      },
      {
        id: 202,
        siteId: 20,
        username: 'bob@example.com',
        accessToken: 'session-bob',
        status: 'expired',
        site: { id: 20, name: 'Claude Hub', platform: 'sub2api', status: 'active' },
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens search in the responsive mobile panel and filters cards', async () => {
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

      const filterButton = root.root.find(
        (node) => node.props['data-testid'] === 'accounts-mobile-filter',
      );
      await act(async () => {
        filterButton.props.onClick();
      });

      const searchInput = root.root.find(
        (node) => node.props['data-testid'] === 'accounts-search',
      );
      await act(async () => {
        searchInput.props.onChange({ target: { value: 'Claude Hub' } });
      });

      const rendered = collectText(root.root);
      expect(rendered).toContain('bob@example.com');
      expect(rendered).not.toContain('alice@example.com');
    } finally {
      root?.unmount();
    }
  });
});
