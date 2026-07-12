import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import PricingRefreshSection from './PricingRefreshSection.js';

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    getPricingSettings: vi.fn(),
    savePricingSettings: vi.fn(),
    refreshPricing: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../api.js', () => ({ api: apiMock }));
vi.mock('../../components/Toast.js', () => ({ useToast: () => toastMock }));

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('PricingRefreshSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getPricingSettings.mockResolvedValue({
      enabled: true,
      cronExpr: '0 0 * * *',
      timeZone: 'Asia/Shanghai',
      refreshStates: [
        { scopeType: 'official', scopeId: 0, failureActive: false, lastSuccessAt: '2026-07-12T00:00:00.000Z' },
        { scopeType: 'site', scopeId: 7, failureActive: true, lastFailureKind: 'timeout' },
      ],
    });
    apiMock.savePricingSettings.mockResolvedValue({ success: true });
    apiMock.refreshPricing.mockResolvedValue({ success: true });
  });

  it('shows timezone and saves the independent cron setting', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<PricingRefreshSection />); });
    await flush();
    expect(text(renderer.root)).toContain('Asia/Shanghai');
    expect(text(renderer.root)).toContain('models.dev 官方目录');
    expect(text(renderer.root)).toContain('站点 #7');
    expect(text(renderer.root)).toContain('异常：timeout');
    const cronInput = renderer.root.findByProps({ 'aria-label': '价格刷新 Cron' });
    await act(async () => cronInput.props.onChange({ target: { value: '0 6 * * *' } }));
    const save = renderer.root.findAllByType('button').find((button) => text(button).includes('保存价格刷新设置'))!;
    await act(async () => save.props.onClick());
    expect(apiMock.savePricingSettings).toHaveBeenCalledWith({ enabled: true, cronExpr: '0 6 * * *' });
  });

  it('triggers one manual refresh', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<PricingRefreshSection />); });
    await flush();
    const refresh = renderer.root.findAllByType('button').find((button) => text(button).includes('立即刷新一次'))!;
    await act(async () => refresh.props.onClick());
    expect(apiMock.refreshPricing).toHaveBeenCalledTimes(1);
  });
});
