import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import ModernSelect from '../components/ModernSelect.js';
import { ToastProvider } from '../components/Toast.js';
import Sites from './Sites.js';

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    detectSite: vi.fn(),
    getSiteDisabledModels: vi.fn().mockResolvedValue({ models: [] }),
    getSiteAvailableModels: vi.fn().mockResolvedValue({ models: [] }),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    toast: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
  useToast: () => toastMock,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function collectText(node: any): string {
  const children = node?.children || [];
  return children.map((child: any) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function findPrimarySiteUrlInput(root: ReactTestRenderer) {
  return root.root.find((node) => (
    node.type === 'input'
    && node.props['data-testid'] === 'site-primary-url-input'
  ));
}

function findPlatformSelect(root: ReactTestRenderer) {
  return root.root.findByProps({ 'data-testid': 'site-platform-select' });
}

function findProxyUrlInput(root: ReactTestRenderer) {
  return root.root.find((node) => (
    node.type === 'input'
    && typeof node.props.placeholder === 'string'
    && node.props.placeholder.includes('站点代理')
  ));
}

function findSystemProxyCheckbox(root: ReactTestRenderer) {
  const label = root.root.find((node) => (
    node.type === 'label'
    && collectText(node).includes('使用系统代理')
  ));
  return label.findByType('input');
}

describe('Sites detect race handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('ignores stale detect results after the operator edits the primary site url', async () => {
    const pendingDetect = deferred<{
      platform: string;
      url: string;
      initializationPresetId: string | null;
    }>();
    apiMock.detectSite.mockReturnValueOnce(pendingDetect.promise);

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const openAddButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn btn-primary')
        && JSON.stringify(node.props.children).includes('添加站点')
      ));

      await act(async () => {
        openAddButton.props.onClick();
      });
      await flushMicrotasks();

      const urlInput = findPrimarySiteUrlInput(root);
      await act(async () => {
        urlInput.props.onChange({ target: { value: 'https://stale.example.com/v1' } });
      });
      await flushMicrotasks();

      const detectButton = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn btn-ghost')
        && collectText(node).trim() === '自动检测'
      )).at(-1);
      expect(detectButton).toBeTruthy();
      await act(async () => {
        void detectButton!.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.detectSite).toHaveBeenCalledWith('https://stale.example.com/v1', {
        proxyUrl: null,
        useSystemProxy: false,
      });

      const latestUrlInput = findPrimarySiteUrlInput(root);
      await act(async () => {
        latestUrlInput.props.onChange({ target: { value: 'https://fresh.example.com' } });
      });
      await flushMicrotasks();

      await act(async () => {
        pendingDetect.resolve({
          platform: 'openai',
          url: 'https://stale.example.com',
          initializationPresetId: 'codingplan-openai',
        });
        await pendingDetect.promise;
      });
      await flushMicrotasks();

      expect(findPrimarySiteUrlInput(root).props.value).toBe('https://fresh.example.com');
      expect(findPlatformSelect(root).props.value).toBe('');
      expect(toastMock.info).not.toHaveBeenCalledWith(expect.stringContaining('https://stale.example.com'));
      expect(toastMock.success).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });

  it('ignores blur-started detect results after the operator manually selects a platform', async () => {
    const pendingDetect = deferred<{
      platform: string;
      url: string;
      initializationPresetId: string | null;
    }>();
    apiMock.detectSite.mockReturnValueOnce(pendingDetect.promise);

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const openAddButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn btn-primary')
        && JSON.stringify(node.props.children).includes('添加站点')
      ));

      await act(async () => {
        openAddButton.props.onClick();
      });
      await flushMicrotasks();

      const urlInput = findPrimarySiteUrlInput(root);
      await act(async () => {
        urlInput.props.onChange({ target: { value: 'https://blur.example.com/v1' } });
      });
      await flushMicrotasks();

      await act(async () => {
        urlInput.props.onBlur();
      });
      await flushMicrotasks();

      expect(apiMock.detectSite).toHaveBeenCalledWith('https://blur.example.com/v1', {
        proxyUrl: null,
        useSystemProxy: false,
      });

      const platformSelect = findPlatformSelect(root);
      await act(async () => {
        platformSelect.props.onChange('claude');
      });
      await flushMicrotasks();

      await act(async () => {
        pendingDetect.resolve({
          platform: 'openai',
          url: 'https://blur.example.com',
          initializationPresetId: 'codingplan-openai',
        });
        await pendingDetect.promise;
      });
      await flushMicrotasks();

      expect(findPlatformSelect(root).props.value).toBe('claude');
      expect(toastMock.info).not.toHaveBeenCalledWith(expect.stringContaining('https://blur.example.com'));
      expect(toastMock.success).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });

  it('passes the current proxy settings into manual detection', async () => {
    apiMock.detectSite.mockResolvedValueOnce({
      platform: 'new-api',
      url: 'https://proxied.example.com',
      initializationPresetId: null,
    });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const openAddButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn btn-primary')
        && JSON.stringify(node.props.children).includes('添加站点')
      ));
      await act(async () => {
        openAddButton.props.onClick();
      });
      await flushMicrotasks();

      await act(async () => {
        findPrimarySiteUrlInput(root).props.onChange({
          target: { value: 'https://proxied.example.com' },
        });
        findProxyUrlInput(root).props.onChange({
          target: { value: 'http://127.0.0.1:7890' },
        });
        findSystemProxyCheckbox(root).props.onChange({ target: { checked: true } });
      });
      await flushMicrotasks();

      const detectButton = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn btn-ghost')
        && collectText(node).trim() === '自动检测'
      )).at(-1);
      await act(async () => {
        await detectButton!.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.detectSite).toHaveBeenCalledWith('https://proxied.example.com', {
        proxyUrl: 'http://127.0.0.1:7890',
        useSystemProxy: true,
      });
    } finally {
      root?.unmount();
    }
  });

  it('ignores detect results after the operator changes proxy settings', async () => {
    const pendingDetect = deferred<{
      platform: string;
      url: string;
      initializationPresetId: string | null;
    }>();
    apiMock.detectSite.mockReturnValueOnce(pendingDetect.promise);

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const openAddButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn btn-primary')
        && JSON.stringify(node.props.children).includes('添加站点')
      ));
      await act(async () => openAddButton.props.onClick());
      await flushMicrotasks();

      await act(async () => {
        findPrimarySiteUrlInput(root).props.onChange({
          target: { value: 'https://proxy-race.example.com' },
        });
        findProxyUrlInput(root).props.onChange({
          target: { value: 'http://127.0.0.1:7890' },
        });
      });
      await flushMicrotasks();

      const detectButton = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn btn-ghost')
        && collectText(node).trim() === '自动检测'
      )).at(-1);
      await act(async () => {
        void detectButton!.props.onClick();
      });
      await flushMicrotasks();

      await act(async () => {
        findProxyUrlInput(root).props.onChange({
          target: { value: 'http://127.0.0.1:7891' },
        });
      });
      await flushMicrotasks();

      await act(async () => {
        pendingDetect.resolve({
          platform: 'new-api',
          url: 'https://proxy-race.example.com',
          initializationPresetId: null,
        });
        await pendingDetect.promise;
      });
      await flushMicrotasks();

      expect(findPlatformSelect(root).props.value).toBe('');
      expect(toastMock.success).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });
});
