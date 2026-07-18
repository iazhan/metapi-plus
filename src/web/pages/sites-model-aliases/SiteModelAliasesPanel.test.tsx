import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import SiteModelAliasesPanel from './SiteModelAliasesPanel.js';

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    getSiteModelAliases: vi.fn(),
    updateSiteModelAliases: vi.fn(),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    toast: vi.fn(),
  },
}));

vi.mock('../../api.js', () => ({ api: apiMock }));
vi.mock('../../components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
  useToast: () => toastMock,
}));

function textOf(node: ReactTestInstance): string {
  return (node.children || []).map((child) => (
    typeof child === 'string' ? child : textOf(child)
  )).join('');
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SiteModelAliasesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSiteModelAliases.mockResolvedValue({
      siteId: 7,
      aliases: [{ sourceModel: 'gpt-4o', aliasModel: 'team-fast', enabled: true }],
    });
    apiMock.updateSiteModelAliases.mockResolvedValue({
      siteId: 7,
      aliases: [
        { sourceModel: 'gpt-4o', aliasModel: 'team-fast', enabled: true },
        { sourceModel: 'claude-sonnet-4-6', aliasModel: 'team-reasoning', enabled: true },
      ],
      rebuild: { routesSynchronized: true },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads existing aliases and saves an added mapping', async () => {
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(
        <SiteModelAliasesPanel
          siteId={7}
          availableModels={['gpt-4o', 'claude-sonnet-4-6']}
          isMobile={false}
        />,
      );
    });
    await flush();

    expect(apiMock.getSiteModelAliases).toHaveBeenCalledWith(7);
    expect(root.root.find((node: ReactTestInstance) => (
      node.type === 'input' && node.props['data-field'] === 'alias-model'
    )).props.value).toBe('team-fast');

    const addButton = root.root.find((node: ReactTestInstance) => (
      node.type === 'button' && textOf(node).includes('添加别名')
    ));
    await act(async () => addButton.props.onClick());

    const inputs = root.root.findAll((node: ReactTestInstance) => node.type === 'input');
    const aliasInputs = inputs.filter((node) => node.props['data-field'] === 'alias-model');
    const sourceInputs = inputs.filter((node) => node.props['data-field'] === 'source-model');
    expect(aliasInputs).toHaveLength(2);

    await act(async () => {
      sourceInputs[1]!.props.onChange({ target: { value: 'claude-sonnet-4-6' } });
      aliasInputs[1]!.props.onChange({ target: { value: 'team-reasoning' } });
    });

    const saveButton = root.root.find((node: ReactTestInstance) => (
      node.type === 'button' && textOf(node).trim() === '保存别名'
    ));
    await act(async () => saveButton.props.onClick());
    await flush();

    expect(apiMock.updateSiteModelAliases).toHaveBeenCalledWith(7, [
      { sourceModel: 'gpt-4o', aliasModel: 'team-fast', enabled: true },
      { sourceModel: 'claude-sonnet-4-6', aliasModel: 'team-reasoning', enabled: true },
    ]);
    expect(toastMock.success).toHaveBeenCalledWith('模型别名已保存，路由已同步');
    root.unmount();
  });

  it('does not submit an incomplete row', async () => {
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<SiteModelAliasesPanel siteId={7} availableModels={[]} isMobile />);
    });
    await flush();

    const addButton = root.root.find((node: ReactTestInstance) => (
      node.type === 'button' && textOf(node).includes('添加别名')
    ));
    await act(async () => addButton.props.onClick());
    const saveButton = root.root.find((node: ReactTestInstance) => (
      node.type === 'button' && textOf(node).trim() === '保存别名'
    ));
    await act(async () => saveButton.props.onClick());

    expect(apiMock.updateSiteModelAliases).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith('请填写完整的来源模型和别名');
    root.unmount();
  });

  it('keeps an editable row mounted while its model names change', async () => {
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<SiteModelAliasesPanel siteId={7} availableModels={[]} isMobile={false} />);
    });
    await flush();

    const findSourceInput = () => root.root.find((node: ReactTestInstance) => (
      node.type === 'input' && node.props['data-field'] === 'source-model'
    ));
    const sourceInput = findSourceInput();

    await act(async () => {
      sourceInput.props.onChange({ target: { value: 'gpt-4.1' } });
    });

    expect(findSourceInput()).toBe(sourceInput);
    root.unmount();
  });

  it('uses the shared site editor section and visible field labels', async () => {
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(
        <SiteModelAliasesPanel
          siteId={7}
          availableModels={['gpt-4o']}
          isMobile={false}
        />,
      );
    });
    await flush();

    const section = root.root.findByProps({ 'aria-label': '站点模型别名' });
    expect(String(section.props.className || '')).toContain('site-editor-section');
    expect(textOf(section)).toContain('来源模型');
    expect(textOf(section)).toContain('对外别名');
    root.unmount();
  });
});
