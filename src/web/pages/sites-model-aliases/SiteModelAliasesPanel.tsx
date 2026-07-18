import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';

export type SiteModelAliasInput = {
  sourceModel: string;
  aliasModel: string;
  enabled: boolean;
};

type SiteModelAliasesResponse = {
  aliases?: SiteModelAliasInput[];
  rebuild?: { routesSynchronized?: boolean };
};

type SiteModelAliasesPanelProps = {
  siteId: number;
  availableModels: string[];
  isMobile: boolean;
};

function normalizeRows(rows: SiteModelAliasInput[] | undefined): SiteModelAliasInput[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    sourceModel: String(row.sourceModel || ''),
    aliasModel: String(row.aliasModel || ''),
    enabled: row.enabled !== false,
  }));
}

export default function SiteModelAliasesPanel({
  siteId,
  availableModels,
  isMobile,
}: SiteModelAliasesPanelProps) {
  const toast = useToast();
  const [rows, setRows] = useState<SiteModelAliasInput[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const modelListId = `site-${siteId}-model-alias-sources`;
  const modelOptions = useMemo(
    () => Array.from(new Set(availableModels.map((model) => model.trim()).filter(Boolean)))
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
    [availableModels],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    api.getSiteModelAliases(siteId)
      .then((response: SiteModelAliasesResponse) => {
        if (active) setRows(normalizeRows(response.aliases));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRows([]);
        setLoadError(error instanceof Error ? error.message : '加载模型别名失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [siteId]);

  const updateRow = (index: number, patch: Partial<SiteModelAliasInput>) => {
    setRows((current) => current.map((row, rowIndex) => (
      rowIndex === index ? { ...row, ...patch } : row
    )));
  };

  const addRow = () => {
    setRows((current) => [
      ...current,
      { sourceModel: '', aliasModel: '', enabled: true },
    ]);
  };

  const removeRow = (index: number) => {
    setRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
  };

  const save = async () => {
    const normalized = rows.map((row) => ({
      sourceModel: row.sourceModel.trim(),
      aliasModel: row.aliasModel.trim(),
      enabled: row.enabled !== false,
    }));
    if (normalized.some((row) => !row.sourceModel || !row.aliasModel)) {
      toast.error('请填写完整的来源模型和别名');
      return;
    }
    const aliasKeys = normalized.map((row) => row.aliasModel.toLowerCase());
    if (new Set(aliasKeys).size !== aliasKeys.length) {
      toast.error('同一站点不能配置重复别名');
      return;
    }

    setSaving(true);
    try {
      const response = await api.updateSiteModelAliases(siteId, normalized) as SiteModelAliasesResponse;
      setRows(normalizeRows(response.aliases));
      if (response.rebuild?.routesSynchronized === false) {
        toast.error('模型别名已保存，但路由同步失败，请重试保存');
      } else {
        toast.success('模型别名已保存，路由已同步');
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : '保存模型别名失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-label="站点模型别名"
      className="site-editor-section"
    >
      <div className="site-editor-section-header">
        <div>
          <h3 className="site-editor-section-title">模型别名</h3>
          <p className="site-editor-section-description">
            为站点模型增加稳定的对外名称；保存后会同步重建相关路由。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ border: '1px solid var(--color-border)' }}
          onClick={addRow}
          disabled={loading || saving}
        >
          + 添加别名
        </button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, fontSize: 12, color: 'var(--color-text-muted)' }}>
          <span className="spinner spinner-sm" /> 加载中...
        </div>
      ) : loadError ? (
        <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--color-danger)' }}>{loadError}</div>
      ) : (
        <>
          <datalist id={modelListId}>
            {modelOptions.map((model) => <option key={model} value={model} />)}
          </datalist>
          <div className="site-editor-list">
            {rows.length === 0 ? (
              <div className="site-editor-empty">
                暂无模型别名
              </div>
            ) : rows.map((row, index) => (
              <div
                key={index}
                className="site-editor-list-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr) auto',
                  alignItems: 'end',
                  gap: 10,
                }}
              >
                <label className="site-editor-field">
                  <span className="site-editor-field-label">来源模型</span>
                  <input
                    data-field="source-model"
                    aria-label={`来源模型 ${index + 1}`}
                    list={modelListId}
                    value={row.sourceModel}
                    onChange={(event) => updateRow(index, { sourceModel: event.target.value })}
                    placeholder="选择或输入来源模型"
                    className="site-editor-control"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  />
                </label>
                <label className="site-editor-field">
                  <span className="site-editor-field-label">对外别名</span>
                  <input
                    data-field="alias-model"
                    aria-label={`对外别名 ${index + 1}`}
                    value={row.aliasModel}
                    onChange={(event) => updateRow(index, { aliasModel: event.target.value })}
                    placeholder="输入对外模型名"
                    className="site-editor-control"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  />
                </label>
                <div className="site-editor-row-actions">
                  <label className="site-editor-check-control">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={(event) => updateRow(index, { enabled: event.target.checked })}
                    />
                    启用
                  </label>
                  <button
                    type="button"
                    className="btn btn-link btn-link-danger"
                    onClick={() => removeRow(index)}
                    aria-label={`删除别名 ${index + 1}`}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="site-editor-save-row">
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? <><span className="spinner spinner-sm" /> 保存中...</> : '保存别名'}
            </button>
            <span className="site-editor-meta">已配置 {rows.length} 条</span>
          </div>
        </>
      )}
    </section>
  );
}
