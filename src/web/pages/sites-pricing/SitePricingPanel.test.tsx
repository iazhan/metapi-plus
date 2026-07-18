import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import SitePricingPanel from './SitePricingPanel.js';
import SiteModelPricingList from './SiteModelPricingList.js';
import SiteModelPriceRuleEditor from './SiteModelPriceRuleEditor.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSitePricing: vi.fn(),
    saveSitePricingProfile: vi.fn(),
    saveSiteModelPriceRule: vi.fn(),
    deleteSiteModelPriceRule: vi.fn(),
  },
}));
vi.mock('../../api.js', () => ({ api: apiMock }));

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

describe('SitePricingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSitePricing.mockResolvedValue({
      siteId: 1,
      profile: { paidCny: 2, creditedUsd: 10 },
      models: [{ upstreamModelId: 'gpt-custom', inputPerMillionUsd: 1, pricingSemantics: 'base_price' }],
      rules: [{ upstreamModelId: 'gpt-custom', mappingMode: 'custom', inputOverrideUsd: 0 }],
      catalog: [],
      referenceAccountId: 7,
      effectiveModels: [{
        upstreamModelId: 'gpt-custom', mappingSource: 'custom',
        inputPerMillionUsd: 0, outputPerMillionUsd: null, perCallUsd: null,
        cacheReadPerMillionUsd: 0, cacheWritePerMillionUsd: null, reasoningPerMillionUsd: null,
        inputAudioPerMillionUsd: null, outputAudioPerMillionUsd: null,
        groupRatio: 1, groupRatioApplied: true,
        priceSources: { inputPerMillionUsd: 'manual', cacheReadPerMillionUsd: 'manual' },
      }],
      refreshState: null,
    });
    apiMock.saveSitePricingProfile.mockResolvedValue({ success: true });
    apiMock.saveSiteModelPriceRule.mockResolvedValue({ success: true });
    apiMock.deleteSiteModelPriceRule.mockResolvedValue({ success: true });
  });

  it('shows recharge conversion, textual sources, and a free override', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<SitePricingPanel siteId={1} isMobile={false} />); });
    await flush();
    expect(text(renderer.root)).toContain('1 USD = 0.2 CNY');
    expect(text(renderer.root)).toContain('自定义');
    expect(text(renderer.root)).toContain('免费');
    expect(text(renderer.root)).toContain('缓存读 手动');
    expect(text(renderer.root)).toContain('参考账号 #7');
  });

  it('uses the shared site editor hierarchy and field controls', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<SitePricingPanel siteId={1} isMobile={false} />); });
    await flush();

    const section = renderer.root.findByProps({ 'aria-label': '站点价格与成本' });
    expect(String(section.props.className || '')).toContain('site-editor-section');
    expect(text(section)).toContain('充值换算');
    expect(text(section)).toContain('模型价格规则');
    const paidInput = renderer.root.findByProps({ 'aria-label': '实际支付 CNY' });
    expect(String(paidInput.props.className || '')).toContain('site-editor-control');
  });

  it('saves profile values and restores model inheritance', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<SitePricingPanel siteId={1} isMobile />); });
    await flush();
    const paid = renderer.root.findByProps({ 'aria-label': '实际支付 CNY' });
    await act(async () => paid.props.onChange({ target: { value: '1' } }));
    const save = renderer.root.findAllByType('button').find((button) => text(button).includes('保存充值换算'))!;
    await act(async () => save.props.onClick());
    expect(apiMock.saveSitePricingProfile).toHaveBeenCalledWith(1, { paidCny: 1, creditedUsd: 10 });
    const restore = renderer.root.findAllByType('button').find((button) => text(button).includes('恢复继承'))!;
    await act(async () => restore.props.onClick());
    expect(apiMock.deleteSiteModelPriceRule).toHaveBeenCalledWith(1, 'gpt-custom');
  });

  it('filters models by mapping status and input price source', async () => {
    const view = {
      siteId: 1,
      profile: { paidCny: 1, creditedUsd: 1 },
      models: [
        { upstreamModelId: 'manual-model' },
        { upstreamModelId: 'unmapped-site-model' },
        { upstreamModelId: 'unmapped-official-model' },
      ],
      rules: [],
      catalog: [],
      referenceAccountId: 7,
      effectiveModels: [
        { upstreamModelId: 'manual-model', mappingSource: 'manual', inputPerMillionUsd: 1, outputPerMillionUsd: null, perCallUsd: null, groupRatio: 1, groupRatioApplied: true, priceSources: { inputPerMillionUsd: 'manual' } },
        { upstreamModelId: 'unmapped-site-model', mappingSource: 'unmapped', inputPerMillionUsd: 2, outputPerMillionUsd: null, perCallUsd: null, groupRatio: 1, groupRatioApplied: true, priceSources: { inputPerMillionUsd: 'site' } },
        { upstreamModelId: 'unmapped-official-model', mappingSource: 'unmapped', inputPerMillionUsd: 3, outputPerMillionUsd: null, perCallUsd: null, groupRatio: 1, groupRatioApplied: true, priceSources: { inputPerMillionUsd: 'models_dev' } },
      ],
      refreshState: null,
    } as any;
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<SiteModelPricingList view={view} isMobile busyModel={null} onRestore={() => undefined} onEdit={() => undefined} />); });

    const mapping = renderer.root.findByProps({ 'aria-label': '筛选映射状态' });
    const source = renderer.root.findByProps({ 'aria-label': '筛选价格来源' });
    await act(async () => mapping.props.onChange({ target: { value: 'unmapped' } }));
    await act(async () => source.props.onChange({ target: { value: 'site' } }));

    const rendered = text(renderer.root);
    expect(rendered).toContain('unmapped-site-model');
    expect(rendered).not.toContain('manual-model');
    expect(rendered).not.toContain('unmapped-official-model');
  });

  it('saves every partial override field while preserving zero and inheritance', async () => {
    const onSave = vi.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SiteModelPriceRuleEditor
        modelId="gpt-custom"
        catalog={[]}
        saving={false}
        onSave={onSave}
        onCancel={() => undefined}
      />);
    });
    const cacheRead = renderer.root.findByProps({ 'aria-label': '缓存读取覆盖 USD/百万' });
    const reasoning = renderer.root.findByProps({ 'aria-label': '推理覆盖 USD/百万' });
    await act(async () => cacheRead.props.onChange({ target: { value: '0' } }));
    await act(async () => reasoning.props.onChange({ target: { value: '3' } }));
    const save = renderer.root.findAllByType('button').find((button) => text(button).includes('保存模型规则'))!;
    await act(async () => save.props.onClick());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      cacheReadOverrideUsd: 0,
      cacheWriteOverrideUsd: null,
      reasoningOverrideUsd: 3,
      inputAudioOverrideUsd: null,
      outputAudioOverrideUsd: null,
    }));
  });
});
