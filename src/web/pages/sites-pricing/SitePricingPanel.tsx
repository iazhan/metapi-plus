import React, { useEffect, useMemo, useState } from 'react';
import { api, type SitePricingView } from '../../api.js';
import ResponsiveFormGrid from '../../components/ResponsiveFormGrid.js';
import SiteModelPricingList from './SiteModelPricingList.js';
import SiteModelPriceRuleEditor from './SiteModelPriceRuleEditor.js';

type Props = { siteId: number; isMobile: boolean };

export default function SitePricingPanel({ siteId, isMobile }: Props) {
  const [view, setView] = useState<SitePricingView | null>(null);
  const [paidCny, setPaidCny] = useState('1');
  const [creditedUsd, setCreditedUsd] = useState('1');
  const [saving, setSaving] = useState(false);
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const next = await api.getSitePricing(siteId);
      setView(next);
      setPaidCny(String(next.profile.paidCny));
      setCreditedUsd(String(next.profile.creditedUsd));
      setError('');
    } catch (reason) {
      setError((reason as Error).message || '站点价格加载失败');
    }
  };
  useEffect(() => { void load(); }, [siteId]);
  const paid = Number(paidCny);
  const credited = Number(creditedUsd);
  const profileValid = Number.isFinite(paid) && paid > 0 && Number.isFinite(credited) && credited > 0;
  const conversion = useMemo(() => profileValid ? paid / credited : null, [credited, paid, profileValid]);

  const saveProfile = async () => {
    if (!profileValid) { setError('两个充值换算值都必须是有限正数'); return; }
    setSaving(true);
    try {
      await api.saveSitePricingProfile(siteId, { paidCny: paid, creditedUsd: credited });
      await load();
    } catch (reason) {
      setError((reason as Error).message || '充值换算保存失败');
    } finally { setSaving(false); }
  };
  const restore = async (modelId: string) => {
    setBusyModel(modelId);
    try { await api.deleteSiteModelPriceRule(siteId, modelId); await load(); }
    catch (reason) { setError((reason as Error).message || '恢复继承失败'); }
    finally { setBusyModel(null); }
  };
  const saveRule = async (rule: import('../../api.js').SiteModelPriceRulePayload) => {
    if (!editingModel) return;
    setBusyModel(editingModel);
    try { await api.saveSiteModelPriceRule(siteId, editingModel, rule); setEditingModel(null); await load(); }
    catch (reason) { setError((reason as Error).message || '模型规则保存失败'); }
    finally { setBusyModel(null); }
  };

  return (
    <section style={{ marginTop: 16, padding: 14, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>价格与成本</div>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.6, marginBottom: 12 }}>
        充值换算只属于站点；价格来源按手动覆盖、站点报价、models.dev 逐字段继承。
      </div>
      {view?.referenceAccountId ? (
        <div className="info-tip" style={{ marginBottom: 12 }}>
          列表中的分组倍率按参考账号 #{view.referenceAccountId} 的当前分组计算；账号或令牌分组不同，倍率可能不同。
        </div>
      ) : null}
      <ResponsiveFormGrid>
        <label style={{ display: 'grid', gap: 6, fontSize: 12 }}>
          实际支付 CNY
          <input aria-label="实际支付 CNY" type="number" min={0} step="any" value={paidCny} onChange={(event) => setPaidCny(event.target.value)} style={{ minHeight: 44, padding: '10px 12px' }} />
        </label>
        <label style={{ display: 'grid', gap: 6, fontSize: 12 }}>
          站点到账 USD
          <input aria-label="站点到账 USD" type="number" min={0} step="any" value={creditedUsd} onChange={(event) => setCreditedUsd(event.target.value)} style={{ minHeight: 44, padding: '10px 12px' }} />
        </label>
      </ResponsiveFormGrid>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
        {conversion === null ? '请输入两个正数' : `1 USD = ${conversion} CNY`}
      </div>
      {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--color-error)' }}>{error}</div>}
      <button className="btn btn-primary" style={{ minHeight: 44, marginTop: 10 }} disabled={saving || !profileValid} onClick={saveProfile}>
        {saving ? '保存中…' : '保存充值换算'}
      </button>
      <div style={{ marginTop: 16 }}>
        {view ? <>
          <SiteModelPricingList view={view} isMobile={isMobile} busyModel={busyModel} onRestore={restore} onEdit={setEditingModel} />
          {editingModel && <SiteModelPriceRuleEditor
            modelId={editingModel}
            catalog={view.catalog}
            initial={view.rules.find((rule) => rule.upstreamModelId === editingModel)}
            saving={busyModel === editingModel}
            onSave={saveRule}
            onCancel={() => setEditingModel(null)}
          />}
        </> : <div className="skeleton" style={{ height: 96 }} />}
      </div>
    </section>
  );
}
