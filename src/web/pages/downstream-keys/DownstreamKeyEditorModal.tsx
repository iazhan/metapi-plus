import React, { useEffect, useMemo, useState } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import { generateDownstreamSkKey } from '../helpers/generateDownstreamSkKey.js';
import {
  getRoutePermissionModelName,
  isExactModelOption,
  isGroupRouteOption,
  type RouteSelectorItem,
} from './routePermissions.js';

const PROXY_TOKEN_PREFIX = 'sk-';

export type DownstreamExcludedCredentialRef =
  | {
    kind: 'account_token';
    siteId: number;
    accountId: number;
    tokenId: number;
  }
  | {
    kind: 'default_api_key';
    siteId: number;
    accountId: number;
  };

export type DownstreamKeyEditorForm = {
  name: string;
  key: string;
  description: string;
  groupName: string;
  tags: string[];
  maxCost: string;
  maxRequests: string;
  expiresAt: string;
  enabled: boolean;
  selectedModels: string[];
  selectedGroupRouteIds: number[];
  legacyModelRules: string[];
  siteWeightMultipliersText: string;
  excludedSiteIds: number[];
  excludedCredentialRefs: DownstreamExcludedCredentialRef[];
};

export type DownstreamSiteOption = {
  siteId: number;
  siteName: string;
  accountCount: number;
};

export type DownstreamCredentialOption = {
  key: string;
  ref: DownstreamExcludedCredentialRef;
  siteName: string;
  accountName: string;
  label: string;
  detail: string;
};

function parseTagText(value: string): string[] {
  return value
    .split(/[\r\n,，]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTags(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const normalized = value.slice(0, 32);
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(normalized);
    if (result.length >= 20) break;
  }
  return result;
}

function uniqStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function uniqIds(values: number[]): number[] {
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0).map((value) => Math.trunc(value)))];
}

function routeTitle(route: RouteSelectorItem): string {
  const displayName = (route.displayName || '').trim();
  return displayName || route.modelPattern;
}

function tagChipStyle(kind: 'normal' | 'accent' = 'normal'): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 11,
    border: '1px solid var(--color-border-light)',
    color: kind === 'accent' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
    background: kind === 'accent'
      ? 'color-mix(in srgb, var(--color-primary) 10%, transparent)'
      : 'var(--color-bg-card)',
  };
}

function buildExcludedCredentialRefKey(ref: DownstreamExcludedCredentialRef): string {
  return ref.kind === 'account_token'
    ? `${ref.kind}:${ref.siteId}:${ref.accountId}:${ref.tokenId}`
    : `${ref.kind}:${ref.siteId}:${ref.accountId}`;
}

function normalizeExcludedSiteIds(values: number[]): number[] {
  return uniqIds(values).sort((left, right) => left - right);
}

function normalizeExcludedCredentialRefs(values: DownstreamExcludedCredentialRef[]): DownstreamExcludedCredentialRef[] {
  const deduped = new Map<string, DownstreamExcludedCredentialRef>();
  for (const value of values) {
    if (!value || !Number.isFinite(value.siteId) || !Number.isFinite(value.accountId)) continue;
    if (value.kind === 'account_token') {
      if (!Number.isFinite(value.tokenId)) continue;
      const normalized: DownstreamExcludedCredentialRef = {
        kind: 'account_token',
        siteId: Math.trunc(value.siteId),
        accountId: Math.trunc(value.accountId),
        tokenId: Math.trunc(value.tokenId),
      };
      deduped.set(buildExcludedCredentialRefKey(normalized), normalized);
      continue;
    }
    const normalized: DownstreamExcludedCredentialRef = {
      kind: 'default_api_key',
      siteId: Math.trunc(value.siteId),
      accountId: Math.trunc(value.accountId),
    };
    deduped.set(buildExcludedCredentialRefKey(normalized), normalized);
  }
  return Array.from(deduped.values()).sort((left, right) => buildExcludedCredentialRefKey(left).localeCompare(buildExcludedCredentialRefKey(right)));
}

export function TagInput({
  tags,
  onChange,
  suggestions = [],
  placeholder,
  inputId,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  inputId?: string;
}) {
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setDraft('');
  }, [tags.length]);

  const commitDraft = () => {
    const nextTags = normalizeTags([...tags, ...parseTagText(draft)]);
    if (nextTags.length !== tags.length) {
      onChange(nextTags);
    }
    setDraft('');
  };

  const removeTag = (target: string) => {
    onChange(tags.filter((tag) => tag !== target));
  };

  const suggestionPool = suggestions.filter((tag) => !tags.some((current) => current.toLowerCase() === tag.toLowerCase())).slice(0, 12);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tags.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => removeTag(tag)}
                style={{ ...tagChipStyle('accent'), cursor: 'pointer' }}
                title={`移除 ${tag}`}
              >
                <span>{tag}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        ) : null}
        <input
          id={inputId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commitDraft();
            } else if (e.key === 'Backspace' && !draft && tags.length > 0) {
              e.preventDefault();
              onChange(tags.slice(0, -1));
            }
          }}
          placeholder={placeholder || '输入标签后按回车或逗号'}
          style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', color: 'var(--color-text-primary)', padding: 0, fontSize: 13, lineHeight: 1.45 }}
        />
      </div>
      {suggestionPool.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {suggestionPool.map((tag) => (
            <button
              key={tag}
              type="button"
              className="btn btn-ghost"
              style={{ ...tagChipStyle(), cursor: 'pointer' }}
              onClick={() => onChange(normalizeTags([...tags, tag]))}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function DownstreamKeyEditorModal({
  open,
  editingItem,
  form,
  onChange,
  onClose,
  onSave,
  saving,
  routeOptions,
  groupSuggestions,
  tagSuggestions,
  exclusionSourceLoading,
  siteOptions,
  credentialOptions,
}: {
  open: boolean;
  editingItem: { id: number } | null;
  form: DownstreamKeyEditorForm;
  onChange: (updater: (prev: DownstreamKeyEditorForm) => DownstreamKeyEditorForm) => void;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  routeOptions: RouteSelectorItem[];
  groupSuggestions: string[];
  tagSuggestions: string[];
  exclusionSourceLoading: boolean;
  siteOptions: DownstreamSiteOption[];
  credentialOptions: DownstreamCredentialOption[];
}) {
  const [modelSearch, setModelSearch] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [siteSearch, setSiteSearch] = useState('');
  const [credentialSearch, setCredentialSearch] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setModelSearch('');
      setGroupSearch('');
      setSiteSearch('');
      setCredentialSearch('');
      setAdvancedOpen(false);
    }
  }, [open]);

  const exactModels = useMemo(
    () => uniqStrings(routeOptions.filter(isExactModelOption).map(getRoutePermissionModelName)).sort((a, b) => a.localeCompare(b)),
    [routeOptions],
  );
  const groupRouteOptions = useMemo(
    () => routeOptions.filter(isGroupRouteOption),
    [routeOptions],
  );
  const validGroupRouteIdSet = useMemo(
    () => new Set(groupRouteOptions.map((route) => route.id)),
    [groupRouteOptions],
  );
  const normalizedSelectedGroupRouteIds = useMemo(
    () => uniqIds(form.selectedGroupRouteIds.filter((id) => validGroupRouteIdSet.has(id))),
    [form.selectedGroupRouteIds, validGroupRouteIdSet],
  );

  const filteredModels = useMemo(() => {
    const keyword = modelSearch.trim().toLowerCase();
    if (!keyword) return exactModels;
    return exactModels.filter((model) => model.toLowerCase().includes(keyword));
  }, [exactModels, modelSearch]);

  const filteredGroups = useMemo(() => {
    const keyword = groupSearch.trim().toLowerCase();
    if (!keyword) return groupRouteOptions;
    return groupRouteOptions.filter((route) => {
      const title = routeTitle(route).toLowerCase();
      return title.includes(keyword) || route.modelPattern.toLowerCase().includes(keyword);
    });
  }, [groupRouteOptions, groupSearch]);

  const filteredSites = useMemo(() => {
    const keyword = siteSearch.trim().toLowerCase();
    if (!keyword) return siteOptions;
    return siteOptions.filter((site) => site.siteName.toLowerCase().includes(keyword));
  }, [siteOptions, siteSearch]);

  const filteredCredentials = useMemo(() => {
    const keyword = credentialSearch.trim().toLowerCase();
    if (!keyword) return credentialOptions;
    return credentialOptions.filter((item) => (
      item.siteName.toLowerCase().includes(keyword)
      || item.accountName.toLowerCase().includes(keyword)
      || item.label.toLowerCase().includes(keyword)
      || item.detail.toLowerCase().includes(keyword)
    ));
  }, [credentialOptions, credentialSearch]);

  const selectedModelCount = form.selectedModels.length;
  const selectedGroupCount = normalizedSelectedGroupRouteIds.length;
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
    fontSize: 13,
    lineHeight: 1.45,
  };

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={editingItem ? '编辑下游密钥' : '新增下游密钥'}
      maxWidth={860}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      footer={(
        <>
          <button onClick={onClose} className="btn btn-ghost" disabled={saving}>取消</button>
          <button onClick={onSave} className="btn btn-primary" disabled={saving}>
            {saving
              ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</>
              : (editingItem ? '保存修改' : '创建密钥')}
          </button>
        </>
      )}
    >
      <div className="info-tip" style={{ marginBottom: 0 }}>
        归属分组和标签只用于管理归类；精确模型和路由群组决定该密钥可访问的模型范围。
      </div>

      <section className="downstream-key-modal-section">
        <div className="downstream-key-modal-section-title">基础信息</div>
        <div className="downstream-key-modal-grid">
          <div className="downstream-key-modal-field">
            <label className="downstream-key-modal-label" htmlFor="downstream-key-editor-name">名称</label>
            <input id="downstream-key-editor-name" value={form.name} onChange={(e) => onChange((prev) => ({ ...prev, name: e.target.value }))} placeholder="例如：项目 A / 移动端" style={inputStyle} />
          </div>
          <div className="downstream-key-modal-field">
            <label className="downstream-key-modal-label" htmlFor="downstream-key-editor-key">下游密钥</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', minWidth: 0 }}>
              <input
                id="downstream-key-editor-key"
                value={form.key}
                onChange={(e) => onChange((prev) => ({ ...prev, key: e.target.value }))}
                placeholder="sk-..."
                style={{ ...inputStyle, flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)' }}
              />
              <button
                type="button"
                className="btn btn-ghost"
                style={{ flexShrink: 0, whiteSpace: 'nowrap', alignSelf: 'stretch' }}
                onClick={() => onChange((prev) => ({ ...prev, key: generateDownstreamSkKey(PROXY_TOKEN_PREFIX) }))}
              >
                随机
              </button>
            </div>
          </div>
          <div className="downstream-key-modal-field downstream-key-modal-field-full">
            <label className="downstream-key-modal-label" htmlFor="downstream-key-editor-description">备注说明</label>
            <textarea
              id="downstream-key-editor-description"
              value={form.description}
              onChange={(e) => onChange((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="填写业务场景、负责人或限制说明"
              style={{ ...inputStyle, minHeight: 72, resize: 'vertical' }}
            />
          </div>
          <label className="downstream-key-modal-toggle downstream-key-modal-field-full">
            <input type="checkbox" checked={form.enabled} onChange={(e) => onChange((prev) => ({ ...prev, enabled: e.target.checked }))} />
            <div>
              <div className="downstream-key-modal-toggle-title">启用密钥</div>
              <div className="downstream-key-modal-help">关闭后该密钥无法访问代理接口</div>
            </div>
          </label>
        </div>
      </section>

      <section className="downstream-key-modal-section">
        <div className="downstream-key-modal-section-title">管理归类</div>
        <div className="downstream-key-modal-grid">
          <div className="downstream-key-modal-field">
            <label className="downstream-key-modal-label" htmlFor="downstream-key-editor-group">归属分组</label>
            <input
              id="downstream-key-editor-group"
              value={form.groupName}
              onChange={(e) => onChange((prev) => ({ ...prev, groupName: e.target.value }))}
              placeholder="例如：内部项目 / 商务客户 / A组"
              list="downstream-group-suggestions"
              style={inputStyle}
            />
            <div className="downstream-key-modal-help">每个密钥只能设置一个归属分组。</div>
          </div>
          <div className="downstream-key-modal-field">
            <label className="downstream-key-modal-label" htmlFor="downstream-key-editor-tags">标签</label>
            <TagInput
              inputId="downstream-key-editor-tags"
              tags={form.tags}
              onChange={(tags) => onChange((prev) => ({ ...prev, tags }))}
              suggestions={tagSuggestions}
              placeholder="例如：移动端、VIP、生产环境"
            />
            <div className="downstream-key-modal-help">一个密钥可设置多个标签。</div>
          </div>
        </div>
      </section>

      <section className="downstream-key-modal-section">
        <div className="downstream-key-modal-section-title">额度与有效期</div>
        <div className="downstream-key-modal-grid downstream-key-modal-grid-three">
          <div className="downstream-key-modal-field">
            <label className="downstream-key-modal-label" htmlFor="downstream-key-editor-max-requests">请求额度</label>
            <input id="downstream-key-editor-max-requests" value={form.maxRequests} onChange={(e) => onChange((prev) => ({ ...prev, maxRequests: e.target.value }))} placeholder="留空表示不限" style={inputStyle} />
          </div>
          <div className="downstream-key-modal-field">
            <label className="downstream-key-modal-label" htmlFor="downstream-key-editor-max-cost">成本额度</label>
            <input id="downstream-key-editor-max-cost" value={form.maxCost} onChange={(e) => onChange((prev) => ({ ...prev, maxCost: e.target.value }))} placeholder="留空表示不限" style={inputStyle} />
          </div>
          <div className="downstream-key-modal-field">
            <label className="downstream-key-modal-label" htmlFor="downstream-key-editor-expires-at">过期时间</label>
            <input id="downstream-key-editor-expires-at" type="datetime-local" value={form.expiresAt} onChange={(e) => onChange((prev) => ({ ...prev, expiresAt: e.target.value }))} style={inputStyle} />
          </div>
        </div>
      </section>

      <div className="downstream-key-advanced">
        <button
          type="button"
          className={`downstream-key-advanced-toggle ${advancedOpen ? 'is-open' : ''}`.trim()}
          aria-expanded={advancedOpen}
          aria-controls="downstream-key-editor-advanced-content"
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          <span>路由权限与分发</span>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{advancedOpen ? '收起' : '展开'}</span>
        </button>
        {advancedOpen ? (
          <div id="downstream-key-editor-advanced-content" className="downstream-key-advanced-content">
            <div className="info-tip" style={{ marginBottom: 0 }}>
              精确模型、兼容模型规则与路由群组按并集授权；三项都为空时，该密钥不能访问任何模型。
            </div>
            <div className="downstream-key-modal-field downstream-key-modal-field-full">
              <label className="downstream-key-modal-label" htmlFor="downstream-key-editor-site-multipliers">站点路由倍率（JSON）</label>
              <textarea
                id="downstream-key-editor-site-multipliers"
                value={form.siteWeightMultipliersText}
                onChange={(e) => onChange((prev) => ({ ...prev, siteWeightMultipliersText: e.target.value }))}
                placeholder={'例如：{\n  "1": 1.2,\n  "7": 0.8\n}'}
                style={{ ...inputStyle, minHeight: 96, resize: 'vertical', fontFamily: 'var(--font-mono)' }}
              />
              <div className="downstream-key-modal-help">用于对特定站点做分发倍率微调；留空或 `{}` 表示走默认倍率。</div>
            </div>

            <div className="downstream-key-advanced-grid" style={{ gridTemplateColumns: '1fr' }}>
              {form.legacyModelRules.length > 0 ? (
                <div className="downstream-key-advanced-panel">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div>
                      <div className="downstream-key-modal-section-title">兼容模型规则</div>
                      <div className="downstream-key-modal-help">保留旧配置中当前无法映射为精确模型或路由群组的规则。</div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ border: '1px solid var(--color-border)' }}
                      onClick={() => onChange((prev) => ({ ...prev, legacyModelRules: [] }))}
                    >
                      全部移除
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {form.legacyModelRules.map((rule) => (
                      <div key={rule} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--color-border-light)' }}>
                        <code style={{ minWidth: 0, overflowWrap: 'anywhere', color: 'var(--color-text-primary)', fontSize: 12 }}>{rule}</code>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => onChange((prev) => ({
                            ...prev,
                            legacyModelRules: prev.legacyModelRules.filter((item) => item !== rule),
                          }))}
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="downstream-key-advanced-panel">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div>
                    <div className="downstream-key-modal-section-title">精确模型权限</div>
                    <div className="downstream-key-modal-help">授权直接使用的精确模型名和站点模型别名；与下方群组授权取并集。</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => onChange((prev) => ({ ...prev, selectedModels: exactModels }))}>全选</button>
                    <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => onChange((prev) => ({ ...prev, selectedModels: [] }))}>清空</button>
                  </div>
                </div>
                <div className="downstream-key-modal-meta">已选 {selectedModelCount} 个模型</div>
                <div className="toolbar-search" style={{ maxWidth: '100%' }}>
                  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} placeholder="搜索模型" />
                </div>
                <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {filteredModels.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>暂无匹配模型</div>
                  ) : filteredModels.map((model) => {
                    const checked = form.selectedModels.includes(model);
                    return (
                      <label key={model} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--color-border-light)', background: checked ? 'color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-card))' : 'var(--color-bg-card)' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onChange((prev) => ({
                            ...prev,
                            selectedModels: checked ? prev.selectedModels.filter((item) => item !== model) : [...prev.selectedModels, model],
                          }))}
                        />
                        <code style={{ color: 'var(--color-text-primary)', fontSize: 12 }}>{model}</code>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="downstream-key-advanced-panel">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div>
                    <div className="downstream-key-modal-section-title">路由群组权限</div>
                    <div className="downstream-key-modal-help">授权通配符、正则或显式群组路由；与上方精确模型授权取并集。</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => onChange((prev) => ({ ...prev, selectedGroupRouteIds: groupRouteOptions.map((route) => route.id) }))}>全选</button>
                    <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => onChange((prev) => ({ ...prev, selectedGroupRouteIds: [] }))}>清空</button>
                  </div>
                </div>
                <div className="downstream-key-modal-meta">已选 {selectedGroupCount} 个路由群组</div>
                <div className="toolbar-search" style={{ maxWidth: '100%' }}>
                  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input value={groupSearch} onChange={(e) => setGroupSearch(e.target.value)} placeholder="搜索路由群组或模型模式" />
                </div>
                <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {filteredGroups.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>暂无匹配路由群组</div>
                  ) : filteredGroups.map((route) => {
                    const checked = normalizedSelectedGroupRouteIds.includes(route.id);
                    return (
                      <label key={route.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--color-border-light)', background: checked ? 'color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-card))' : 'var(--color-bg-card)' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onChange((prev) => ({
                            ...prev,
                            selectedGroupRouteIds: checked
                              ? prev.selectedGroupRouteIds.filter((item) => item !== route.id)
                              : uniqIds([...prev.selectedGroupRouteIds.filter((item) => validGroupRouteIdSet.has(item)), route.id]),
                          }))}
                          style={{ marginTop: 2 }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 600 }}>
                            {routeTitle(route)}
                            {!route.enabled ? <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-danger)' }}>已禁用</span> : null}
                          </div>
                          <code style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--color-text-muted)' }}>{route.modelPattern}</code>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="downstream-key-advanced-panel">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div>
                    <div className="downstream-key-modal-section-title">排除站点</div>
                    <div className="downstream-key-modal-help">命中的站点会直接跳过，不参与当前下游密钥的通道路由。</div>
                  </div>
                  <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => onChange((prev) => ({ ...prev, excludedSiteIds: [] }))}>清空</button>
                </div>
                <div className="downstream-key-modal-meta">已排除 {form.excludedSiteIds.length} 个站点</div>
                <div className="toolbar-search" style={{ maxWidth: '100%' }}>
                  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input value={siteSearch} onChange={(e) => setSiteSearch(e.target.value)} placeholder="搜索站点" />
                </div>
                <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {exclusionSourceLoading ? (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>加载站点与令牌中...</div>
                  ) : filteredSites.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>暂无可排除站点</div>
                  ) : filteredSites.map((site) => {
                    const checked = form.excludedSiteIds.includes(site.siteId);
                    return (
                      <label key={site.siteId} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--color-border-light)', background: checked ? 'color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-card))' : 'var(--color-bg-card)' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => onChange((prev) => ({
                            ...prev,
                            excludedSiteIds: normalizeExcludedSiteIds(
                              e.target.checked
                                ? [...prev.excludedSiteIds, site.siteId]
                                : prev.excludedSiteIds.filter((item) => item !== site.siteId),
                            ),
                          }))}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 600 }}>{site.siteName}</div>
                          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-text-muted)' }}>{site.accountCount} 个账号</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="downstream-key-advanced-panel">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div>
                    <div className="downstream-key-modal-section-title">排除 API Key/令牌</div>
                    <div className="downstream-key-modal-help">支持排除显式令牌，以及 `tokenId` 为空时实际使用的默认 API Key。</div>
                  </div>
                  <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => onChange((prev) => ({ ...prev, excludedCredentialRefs: [] }))}>清空</button>
                </div>
                <div className="downstream-key-modal-meta">已排除 {form.excludedCredentialRefs.length} 个凭证</div>
                <div className="toolbar-search" style={{ maxWidth: '100%' }}>
                  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input value={credentialSearch} onChange={(e) => setCredentialSearch(e.target.value)} placeholder="搜索站点 / 账号 / 令牌" />
                </div>
                <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {exclusionSourceLoading ? (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>加载站点与令牌中...</div>
                  ) : filteredCredentials.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>暂无可排除 API Key/令牌</div>
                  ) : filteredCredentials.map((item) => {
                    const checked = form.excludedCredentialRefs.some((ref) => buildExcludedCredentialRefKey(ref) === buildExcludedCredentialRefKey(item.ref));
                    return (
                      <label key={item.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--color-border-light)', background: checked ? 'color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-card))' : 'var(--color-bg-card)' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => onChange((prev) => ({
                            ...prev,
                            excludedCredentialRefs: normalizeExcludedCredentialRefs(
                              e.target.checked
                                ? [...prev.excludedCredentialRefs, item.ref]
                                : prev.excludedCredentialRefs.filter((ref) => buildExcludedCredentialRefKey(ref) !== buildExcludedCredentialRefKey(item.ref)),
                            ),
                          }))}
                          style={{ marginTop: 2 }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 600 }}>{item.label}</div>
                          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-text-muted)' }}>
                            {item.siteName} / {item.accountName}
                          </div>
                          <div style={{ marginTop: 2, fontSize: 11, color: 'var(--color-text-muted)' }}>{item.detail}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <datalist id="downstream-group-suggestions">
        {groupSuggestions.map((group) => <option key={group} value={group} />)}
      </datalist>
    </CenteredModal>
  );
}
