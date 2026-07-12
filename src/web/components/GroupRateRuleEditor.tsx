import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

type Props = {
  accountId: number;
  groupKey: string;
  synchronizedRatio: number | null;
  overrideRatio: number | null;
  onChanged?: () => void | Promise<void>;
};

export default function GroupRateRuleEditor({
  accountId,
  groupKey,
  synchronizedRatio,
  overrideRatio,
  onChanged,
}: Props) {
  const [draft, setDraft] = useState(overrideRatio == null ? '' : String(overrideRatio));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setDraft(overrideRatio == null ? '' : String(overrideRatio)), [overrideRatio]);
  const parsed = draft.trim() === '' ? null : Number(draft);
  const valid = parsed !== null && Number.isFinite(parsed) && parsed >= 0;
  const effective = overrideRatio ?? synchronizedRatio ?? 1;

  const save = async () => {
    if (!valid || parsed === null) {
      setError('手动倍率必须是有限非负数，0 表示免费');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.saveAccountGroupRateRule(accountId, groupKey, parsed);
      await onChanged?.();
    } catch (reason) {
      setError((reason as Error).message || '手动倍率保存失败');
    } finally {
      setSaving(false);
    }
  };

  const restore = async () => {
    setSaving(true);
    setError('');
    try {
      await api.deleteAccountGroupRateRule(accountId, groupKey);
      setDraft('');
      await onChanged?.();
    } catch (reason) {
      setError((reason as Error).message || '恢复继承失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
        <span className="badge badge-muted">同步倍率 {synchronizedRatio ?? '—'}</span>
        <span className="badge badge-info">手动倍率 {overrideRatio ?? '继承'}</span>
        <span className="badge badge-success">有效倍率 {effective}{effective === 0 ? '（免费）' : ''}</span>
      </div>
      <div>
        <label htmlFor={`group-rate-${accountId}-${groupKey}`} style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
          手动倍率
        </label>
        <input
          id={`group-rate-${accountId}-${groupKey}`}
          aria-label="手动倍率"
          type="number"
          min={0}
          step="any"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="留空表示继承"
          style={{
            width: '100%', minHeight: 44, padding: '10px 12px',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
            background: 'var(--color-bg)', color: 'var(--color-text-primary)',
          }}
        />
      </div>
      {error && <div role="alert" style={{ color: 'var(--color-error)', fontSize: 12 }}>{error}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <button className="btn btn-primary" style={{ minHeight: 44 }} disabled={saving || !valid} onClick={save}>
          {saving ? '保存中…' : '保存手动倍率'}
        </button>
        <button className="btn btn-ghost" style={{ minHeight: 44 }} disabled={saving} onClick={restore}>
          恢复继承
        </button>
      </div>
    </div>
  );
}
