import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import Settings from './Settings.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAuthInfo: vi.fn(),
    getRuntimeSettings: vi.fn(),
    getDownstreamApiKeys: vi.fn(),
    getRoutesLite: vi.fn(),
    getRuntimeDatabaseConfig: vi.fn(),
    getBrandList: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    triggerCheckinAll: vi.fn(),
    getModelTokenCandidates: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  normalizeBrandIconKey: (icon: string) => icon,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Settings log cleanup schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAuthInfo.mockResolvedValue({ masked: 'sk-****' });
    apiMock.getRuntimeSettings.mockResolvedValue({
      checkinCron: '0 8 * * *',
      checkinScheduleMode: 'interval',
      checkinIntervalHours: 6,
      balanceRefreshCron: '0 * * * *',
      accountGroupRateRefreshEnabled: true,
      accountGroupRateRefreshIntervalMinutes: 30,
      logCleanupCron: '15 4 * * *',
      logCleanupUsageLogsEnabled: true,
      logCleanupProgramLogsEnabled: true,
      logCleanupRetentionDays: 14,
      routingFallbackUnitCost: 1,
      routingWeights: {},
      adminIpAllowlist: [],
      systemProxyUrl: '',
    });
    apiMock.getDownstreamApiKeys.mockResolvedValue({ items: [] });
    apiMock.getRoutesLite.mockResolvedValue([]);
    apiMock.getBrandList.mockResolvedValue({ brands: [] });
    apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
      active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
      saved: null,
      restartRequired: false,
    });
    apiMock.updateRuntimeSettings.mockResolvedValue({ success: true });
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders account group rate refresh controls from runtime settings', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const toggle = root.root.findByProps({
        'data-testid': 'account-group-rate-refresh-enabled',
      });
      const interval = root.root.findByProps({
        'data-testid': 'account-group-rate-refresh-interval-minutes',
      });

      expect(toggle.props.checked).toBe(true);
      expect(interval.props.value).toBe('30');
    } finally {
      root?.unmount();
    }
  });

  it('groups every scheduled task family under a titled divider', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const sections = [
        ['checkin', '自动签到'],
        ['balance-refresh', '余额自动刷新'],
        ['price-refresh', '价格自动刷新'],
        ['account-rate-refresh', '账号倍率自动刷新'],
        ['log-cleanup', '自动清理日志'],
      ] as const;

      for (const [id, title] of sections) {
        const section = root.root.findByProps({ 'data-testid': `schedule-section-${id}` });
        expect(section.props.style.borderTop).toBe('1px solid var(--color-border-light)');
        expect(collectText(section)).toContain(title);
      }
    } finally {
      root?.unmount();
    }
  });

  it('disables the account group rate refresh interval input when the toggle is off', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const toggle = root.root.findByProps({
        'data-testid': 'account-group-rate-refresh-enabled',
      });

      await act(async () => {
        toggle.props.onChange({ target: { checked: false } });
      });

      const interval = root.root.findByProps({
        'data-testid': 'account-group-rate-refresh-interval-minutes',
      });

      expect(interval.props.disabled).toBe(true);
    } finally {
      root?.unmount();
    }
  });

  it('saves account group rate refresh fields together with other schedule settings', async () => {
    apiMock.getRuntimeSettings.mockResolvedValueOnce({
      checkinCron: '0 8 * * *',
      checkinScheduleMode: 'interval',
      checkinIntervalHours: 6,
      balanceRefreshCron: '0 * * * *',
      accountGroupRateRefreshEnabled: true,
      accountGroupRateRefreshIntervalMinutes: 45,
      logCleanupCron: '15 4 * * *',
      logCleanupUsageLogsEnabled: true,
      logCleanupProgramLogsEnabled: true,
      logCleanupRetentionDays: 14,
      routingFallbackUnitCost: 1,
      routingWeights: {},
      adminIpAllowlist: [],
      systemProxyUrl: '',
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '保存定时任务'
      ));

      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({
        checkinCron: '0 8 * * *',
        checkinScheduleMode: 'interval',
        checkinIntervalHours: 6,
        balanceRefreshCron: '0 * * * *',
        priceRefreshEnabled: true,
        priceRefreshCron: '0 0 * * *',
        priceRefreshScheduleMode: 'cron',
        priceRefreshIntervalHours: 6,
        accountGroupRateRefreshEnabled: true,
        accountGroupRateRefreshIntervalMinutes: 45,
        logCleanupCron: '15 4 * * *',
        logCleanupUsageLogsEnabled: true,
        logCleanupProgramLogsEnabled: true,
        logCleanupRetentionDays: 14,
      });
    } finally {
      root?.unmount();
    }
  });

  it('renders numeric bounds for the account group rate refresh interval input', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const interval = root.root.findByProps({
        'data-testid': 'account-group-rate-refresh-interval-minutes',
      });

      expect(interval.props.min).toBe(5);
      expect(interval.props.max).toBe(10080);
      expect(interval.props.step).toBe(1);
      expect(interval.props.type).toBe('number');
    } finally {
      root?.unmount();
    }
  });

  it('allows editing through a temporary below-minimum value and saves the final interval', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const interval = root.root.findByProps({
        'data-testid': 'account-group-rate-refresh-interval-minutes',
      });

      await act(async () => {
        interval.props.onChange({ target: { value: '' } });
      });

      const afterClear = root.root.findByProps({
        'data-testid': 'account-group-rate-refresh-interval-minutes',
      });
      expect(afterClear.props.value).toBe('');

      await act(async () => {
        afterClear.props.onChange({ target: { value: '3' } });
      });

      const afterThree = root.root.findByProps({
        'data-testid': 'account-group-rate-refresh-interval-minutes',
      });
      expect(afterThree.props.value).toBe('3');

      await act(async () => {
        afterThree.props.onChange({ target: { value: '5' } });
      });

      const afterFive = root.root.findByProps({
        'data-testid': 'account-group-rate-refresh-interval-minutes',
      });
      expect(afterFive.props.value).toBe('5');

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '保存定时任务'
      ));

      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
        accountGroupRateRefreshIntervalMinutes: 5,
      }));
    } finally {
      root?.unmount();
    }
  });

  it('does not send an empty account group rate refresh interval', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const interval = root.root.findByProps({
        'data-testid': 'account-group-rate-refresh-interval-minutes',
      });
      await act(async () => {
        interval.props.onChange({ target: { value: '' } });
      });

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '保存定时任务'
      ));
      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).not.toHaveBeenCalled();
      expect(collectText(root.root)).toContain('倍率刷新间隔必须是 5 到 10080 之间的整数');
    } finally {
      root?.unmount();
    }
  });

  it('triggers a one-off checkin from the schedule card', async () => {
    apiMock.triggerCheckinAll.mockResolvedValue({ success: true });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const triggerButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '测试一次签到'
      ));

      await act(async () => {
        await triggerButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.triggerCheckinAll).toHaveBeenCalledTimes(1);
    } finally {
      root?.unmount();
    }
  });

  it('renders schedule mode controls with modern selects and ghost action styling', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const triggerButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '测试一次签到'
      ));
      const scheduleCard = root.root.find((node) => (
        node.type === 'div'
        && String(node.props.className || '').includes('card')
        && collectText(node).includes('定时任务')
      ));

      expect(scheduleCard.findAllByType('select')).toHaveLength(0);
      expect(scheduleCard.findAllByType(ModernSelect).length).toBeGreaterThanOrEqual(2);
      expect(String(triggerButton.props.className || '')).toContain('btn-ghost');
    } finally {
      root?.unmount();
    }
  });
});
