import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import GroupRateRuleEditor from './GroupRateRuleEditor.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    saveAccountGroupRateRule: vi.fn(),
    deleteAccountGroupRateRule: vi.fn(),
  },
}));
vi.mock('../api.js', () => ({ api: apiMock }));

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}

describe('GroupRateRuleEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.saveAccountGroupRateRule.mockResolvedValue({ success: true });
    apiMock.deleteAccountGroupRateRule.mockResolvedValue({ success: true });
  });

  it('saves zero as a free manual ratio and restores inheritance', async () => {
    const onChanged = vi.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<GroupRateRuleEditor
        accountId={7}
        groupKey="pro/team"
        synchronizedRatio={1.2}
        overrideRatio={null}
        onChanged={onChanged}
      />);
    });
    expect(text(renderer.root)).toContain('同步倍率 1.2');
    const input = renderer.root.findByProps({ 'aria-label': '手动倍率' });
    await act(async () => input.props.onChange({ target: { value: '0' } }));
    const save = renderer.root.findAllByType('button').find((button) => text(button).includes('保存手动倍率'))!;
    await act(async () => save.props.onClick());
    expect(apiMock.saveAccountGroupRateRule).toHaveBeenCalledWith(7, 'pro/team', 0);
    const restore = renderer.root.findAllByType('button').find((button) => text(button).includes('恢复继承'))!;
    await act(async () => restore.props.onClick());
    expect(apiMock.deleteAccountGroupRateRule).toHaveBeenCalledWith(7, 'pro/team');
  });
});
