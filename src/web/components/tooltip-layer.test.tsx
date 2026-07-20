import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseStructuredTooltipDetail } from './TooltipLayer.js';

describe('TooltipLayer component', () => {
  it('uses a portal-based fixed tooltip layer and is mounted by App', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/components/TooltipLayer.tsx'), 'utf8');
    const appSource = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');

    expect(source).toContain('createPortal');
    expect(source).toContain('[data-tooltip]');
    expect(source).toContain("position: 'fixed'");
    expect(source).toContain('document.body.dataset.tooltipPortal');
    expect(appSource).toContain("import TooltipLayer from './components/TooltipLayer.js'");
    expect(appSource).toContain('<TooltipLayer />');
  });

  it('keeps rich detail tooltip colors theme-aware', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8')
      .replace(/\r\n/g, '\n');

    expect(css).toMatch(/\.tooltip-bubble\.is-detail\s*\{/);
    expect(css).toMatch(/\[data-theme="dark"\]\s+\.tooltip-bubble\.is-detail\s*\{/);
    expect(css).toContain('--tooltip-detail-surface: var(--color-bg-card);');
    expect(css).toContain('--tooltip-detail-surface: #101827;');
    expect(css).toContain('.tooltip-detail-value.is-warning');
  });

  it('accepts validated structured rows for rich hover details', () => {
    expect(parseStructuredTooltipDetail(JSON.stringify({
      title: '费用明细',
      sections: [{
        title: '输入',
        rows: [
          { label: '单价', value: '$5.0000 / 1M tokens', tone: 'info' },
          { label: '成本', value: '$0.004745' },
        ],
      }],
    }))).toEqual({
      title: '费用明细',
      sections: [{
        title: '输入',
        rows: [
          { label: '单价', value: '$5.0000 / 1M tokens', tone: 'info' },
          { label: '成本', value: '$0.004745', tone: 'default' },
        ],
      }],
    });

    expect(parseStructuredTooltipDetail('{not-json')).toBeNull();
    expect(parseStructuredTooltipDetail(JSON.stringify({
      title: '空内容',
      sections: [{ rows: [] }],
    }))).toBeNull();
  });
});
