import React, { useEffect, useState, type CSSProperties } from 'react';
import { api, type PricingSettingsView } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { formatDateTimeLocal } from '../helpers/checkinLogTime.js';

const inputStyle: CSSProperties = {
  width: '100%', minHeight: 44, padding: '10px 12px',
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)', color: 'var(--color-text-primary)',
  fontFamily: 'var(--font-mono)', fontSize: 13,
};

export default function PricingRefreshSection() {
  const toast = useToast();
  const [settings, setSettings] = useState<PricingSettingsView | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [cronExpr, setCronExpr] = useState('0 0 * * *');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setError('');
      const next = await api.getPricingSettings();
      setSettings(next);
      setEnabled(next.enabled);
      setCronExpr(next.cronExpr);
    } catch (reason) {
      setError((reason as Error).message || '价格刷新设置加载失败');
    }
  };

  useEffect(() => { void load(); }, []);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.savePricingSettings({ enabled, cronExpr: cronExpr.trim() });
      toast.success('价格刷新设置已保存');
      await load();
    } catch (reason) {
      setError((reason as Error).message || '价格刷新设置保存失败');
    } finally {
      setSaving(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      await api.refreshPricing();
      toast.success('价格刷新已完成');
      await load();
    } catch (reason) {
      setError((reason as Error).message || '价格刷新失败');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="card" style={{ padding: 20 }} aria-labelledby="pricing-refresh-title">
      <div id="pricing-refresh-title" style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
        价格自动刷新
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>
        系统时区：{settings?.timeZone || '加载中…'}。官方目录先刷新，随后最多并发刷新 3 个站点。
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44 }}>
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          启用价格自动刷新
        </label>
        <div>
          <label htmlFor="price-refresh-cron" style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
            价格刷新 Cron
          </label>
          <input
            id="price-refresh-cron"
            aria-label="价格刷新 Cron"
            value={cronExpr}
            onChange={(event) => setCronExpr(event.target.value)}
            style={inputStyle}
          />
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>最近刷新状态</div>
          {settings && settings.refreshStates.length > 0 ? settings.refreshStates.map((row) => (
            <div key={`${row.scopeType}-${row.scopeId}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontSize: 12 }}>{row.scopeType === 'official' ? 'models.dev 官方目录' : `站点 #${row.scopeId}`}</span>
              <span className={`badge ${row.failureActive ? 'badge-warning' : 'badge-success'}`} style={{ fontSize: 11 }}>
                {row.failureActive
                  ? `异常：${row.lastFailureKind || 'upstream'}`
                  : (row.lastSuccessAt ? `最近成功：${formatDateTimeLocal(row.lastSuccessAt)}` : '等待首次成功')}
              </span>
            </div>
          )) : (
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>尚无刷新记录</div>
          )}
        </div>
        {error && <div role="alert" style={{ color: 'var(--color-error)', fontSize: 12 }}>{error}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <button className="btn btn-primary" style={{ minHeight: 44 }} disabled={saving || refreshing} onClick={save}>
            {saving ? '保存中…' : '保存价格刷新设置'}
          </button>
          <button className="btn btn-ghost" style={{ minHeight: 44 }} disabled={saving || refreshing} onClick={refresh}>
            {refreshing ? '刷新中…' : '立即刷新一次'}
          </button>
        </div>
      </div>
    </section>
  );
}
