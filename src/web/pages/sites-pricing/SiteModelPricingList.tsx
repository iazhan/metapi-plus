import { useMemo, useState } from 'react';
import type { SitePricingView } from '../../api.js';
import { MobileField } from '../../components/MobileCard.js';

type Props = {
  view: SitePricingView;
  isMobile: boolean;
  busyModel: string | null;
  onRestore: (modelId: string) => void;
  onEdit: (modelId: string) => void;
};

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export default function SiteModelPricingList({ view, isMobile, busyModel, onRestore, onEdit }: Props) {
  const [search, setSearch] = useState('');
  const [mappingFilter, setMappingFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const rows = useMemo(() => {
    const rules = new Map(view.rules.map((rule) => [rule.upstreamModelId, rule]));
    const effective = new Map(view.effectiveModels.map((model) => [model.upstreamModelId, model]));
    return view.models
      .map((model) => ({ model, rule: rules.get(model.upstreamModelId), effective: effective.get(model.upstreamModelId) }))
      .filter(({ model, effective }) => {
        if (!model.upstreamModelId.toLowerCase().includes(search.trim().toLowerCase())) return false;
        if (mappingFilter !== 'all' && effective?.mappingSource !== mappingFilter) return false;
        if (sourceFilter !== 'all' && effective?.priceSources.inputPerMillionUsd !== sourceFilter) return false;
        return true;
      });
  }, [mappingFilter, search, sourceFilter, view.effectiveModels, view.models, view.rules]);

  const sourceLabel = (source: string | undefined) => {
    if (source === 'manual') return '手动';
    if (source === 'site') return '站点';
    if (source === 'models_dev') return 'models.dev';
    return '缺失';
  };
  const mappingLabel = (mapping: string | undefined) => {
    if (mapping === 'custom') return '自定义';
    if (mapping === 'manual') return '手动映射';
    if (mapping === 'exact') return '精确映射';
    if (mapping === 'date_suffix') return '日期版本映射';
    return '未映射';
  };
  const renderPrice = (value: unknown, unit = '/百万') => {
    const normalized = numberValue(value);
    if (normalized === null) return '缺失';
    if (normalized === 0) return '免费';
    return `$${normalized}${unit}`;
  };
  const renderPriceSummary = (effective: Props['view']['effectiveModels'][number] | undefined) => effective
    ? [
      `输入 ${renderPrice(effective.inputPerMillionUsd)}`,
      `输出 ${renderPrice(effective.outputPerMillionUsd)}`,
      `缓存读 ${renderPrice(effective.cacheReadPerMillionUsd)}`,
      `缓存写 ${renderPrice(effective.cacheWritePerMillionUsd)}`,
      `推理 ${renderPrice(effective.reasoningPerMillionUsd)}`,
      `输入音频 ${renderPrice(effective.inputAudioPerMillionUsd)}`,
      `输出音频 ${renderPrice(effective.outputAudioPerMillionUsd)}`,
      `单次 ${renderPrice(effective.perCallUsd, '/次')}`,
    ].join(' · ')
    : '缺失';
  const renderSourceSummary = (effective: Props['view']['effectiveModels'][number] | undefined) => effective
    ? [
      `输入 ${sourceLabel(effective.priceSources.inputPerMillionUsd)}`,
      `输出 ${sourceLabel(effective.priceSources.outputPerMillionUsd)}`,
      `缓存读 ${sourceLabel(effective.priceSources.cacheReadPerMillionUsd)}`,
      `缓存写 ${sourceLabel(effective.priceSources.cacheWritePerMillionUsd)}`,
      `推理 ${sourceLabel(effective.priceSources.reasoningPerMillionUsd)}`,
      `输入音频 ${sourceLabel(effective.priceSources.inputAudioPerMillionUsd)}`,
      `输出音频 ${sourceLabel(effective.priceSources.outputAudioPerMillionUsd)}`,
      `单次 ${sourceLabel(effective.priceSources.perCallUsd)}`,
    ].join(' · ')
    : '全部缺失';

  return (
    <div className="site-editor-pricing-list">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <label className="site-editor-field">
          <span className="site-editor-field-label">筛选模型</span>
          <input
            aria-label="筛选模型"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="输入模型名称"
            className="site-editor-control"
          />
        </label>
        <label className="site-editor-field">
          <span className="site-editor-field-label">映射状态</span>
          <select aria-label="筛选映射状态" value={mappingFilter} onChange={(event) => setMappingFilter(event.target.value)} className="site-editor-control">
            <option value="all">全部映射状态</option>
            <option value="manual">手动映射</option>
            <option value="exact">精确映射</option>
            <option value="date_suffix">日期版本映射</option>
            <option value="custom">自定义</option>
            <option value="unmapped">未映射</option>
          </select>
        </label>
        <label className="site-editor-field">
          <span className="site-editor-field-label">输入价格来源</span>
          <select aria-label="筛选价格来源" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} className="site-editor-control">
            <option value="all">全部来源</option>
            <option value="manual">手动</option>
            <option value="site">站点</option>
            <option value="models_dev">models.dev</option>
            <option value="missing">缺失</option>
          </select>
        </label>
      </div>
      <div className="site-editor-meta">显示 {rows.length} / {view.models.length} 个模型</div>
      {rows.length === 0 ? (
        <div className="site-editor-empty">暂无匹配模型价格</div>
      ) : isMobile ? (
        <div className="site-editor-model-list">
          {rows.map(({ model, effective }) => (
            <div className="site-editor-model-row" key={model.upstreamModelId}>
              <div className="site-editor-model-title">{model.upstreamModelId}</div>
              <MobileField label="映射" value={mappingLabel(effective?.mappingSource)} />
              <MobileField label="有效价格" value={renderPriceSummary(effective)} />
              <MobileField label="逐字段来源" value={renderSourceSummary(effective)} />
              <MobileField label="有效倍率" value={effective ? `${effective.groupRatio}${effective.groupRatioApplied ? '' : '（价格已含倍率）'}` : '—'} />
              <div className="site-editor-row-actions">
                <button className="btn btn-ghost" disabled={busyModel === model.upstreamModelId} onClick={() => onEdit(model.upstreamModelId)}>
                  编辑规则
                </button>
                <button className="btn btn-ghost" disabled={busyModel === model.upstreamModelId} onClick={() => onRestore(model.upstreamModelId)}>
                  恢复继承
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="site-editor-pricing-table">
            <thead><tr><th style={{ width: '24%' }}>站点模型</th><th style={{ width: '16%' }}>映射</th><th>有效价格与逐字段来源</th><th style={{ width: 110 }}>操作</th></tr></thead>
            <tbody>{rows.map(({ model, effective }) => (
              <tr key={model.upstreamModelId}>
                <td style={{ overflowWrap: 'anywhere' }} title={model.upstreamModelId}>{model.upstreamModelId}</td>
                <td>{mappingLabel(effective?.mappingSource)}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere', lineHeight: 1.6 }}>
                  <div>{renderPriceSummary(effective)}</div>
                  <div style={{ color: 'var(--color-text-muted)' }}>{renderSourceSummary(effective)}</div>
                </td>
                <td>
                  <div className="site-editor-table-actions">
                    <button className="btn btn-link" disabled={busyModel === model.upstreamModelId} onClick={() => onEdit(model.upstreamModelId)}>编辑</button>
                    <button className="btn btn-link" disabled={busyModel === model.upstreamModelId} onClick={() => onRestore(model.upstreamModelId)}>恢复</button>
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
