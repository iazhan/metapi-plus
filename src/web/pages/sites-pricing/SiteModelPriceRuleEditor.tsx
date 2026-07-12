import React, { useState } from 'react';
import type { SiteModelPriceRulePayload, SitePricingView } from '../../api.js';

type Props = {
  modelId: string;
  catalog: SitePricingView['catalog'];
  initial?: SitePricingView['rules'][number];
  saving: boolean;
  onSave: (rule: SiteModelPriceRulePayload) => void;
  onCancel: () => void;
};

const fieldStyle: React.CSSProperties = {
  minHeight: 44, width: '100%', padding: '10px 12px',
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)', color: 'var(--color-text-primary)',
};

export default function SiteModelPriceRuleEditor({ modelId, catalog, initial, saving, onSave, onCancel }: Props) {
  const [mode, setMode] = useState<'manual' | 'custom'>(initial?.mappingMode ?? 'custom');
  const [providerId, setProviderId] = useState(initial?.mappedProviderId ?? '');
  const [catalogModelId, setCatalogModelId] = useState(initial?.mappedModelId ?? '');
  const [input, setInput] = useState(initial?.inputOverrideUsd == null ? '' : String(initial.inputOverrideUsd));
  const [output, setOutput] = useState(initial?.outputOverrideUsd == null ? '' : String(initial.outputOverrideUsd));
  const [cacheRead, setCacheRead] = useState(initial?.cacheReadOverrideUsd == null ? '' : String(initial.cacheReadOverrideUsd));
  const [cacheWrite, setCacheWrite] = useState(initial?.cacheWriteOverrideUsd == null ? '' : String(initial.cacheWriteOverrideUsd));
  const [reasoning, setReasoning] = useState(initial?.reasoningOverrideUsd == null ? '' : String(initial.reasoningOverrideUsd));
  const [inputAudio, setInputAudio] = useState(initial?.inputAudioOverrideUsd == null ? '' : String(initial.inputAudioOverrideUsd));
  const [outputAudio, setOutputAudio] = useState(initial?.outputAudioOverrideUsd == null ? '' : String(initial.outputAudioOverrideUsd));
  const [perCall, setPerCall] = useState(initial?.perCallOverrideUsd == null ? '' : String(initial.perCallOverrideUsd));
  const [error, setError] = useState('');

  const parseOptional = (value: string) => value.trim() === '' ? null : Number(value);
  const submit = () => {
    const values = [input, output, cacheRead, cacheWrite, reasoning, inputAudio, outputAudio, perCall].map(parseOptional);
    if (values.some((value) => value !== null && (!Number.isFinite(value) || value < 0))) {
      setError('覆盖价格必须是有限非负数；留空继承，0 表示免费');
      return;
    }
    if (mode === 'manual' && (!providerId.trim() || !catalogModelId.trim())) {
      setError('手动映射必须同时选择 provider 和官方模型');
      return;
    }
    onSave({
      mappingMode: mode,
      mappedProviderId: mode === 'manual' ? providerId.trim() : null,
      mappedModelId: mode === 'manual' ? catalogModelId.trim() : null,
      inputOverrideUsd: values[0],
      outputOverrideUsd: values[1],
      cacheReadOverrideUsd: values[2],
      cacheWriteOverrideUsd: values[3],
      reasoningOverrideUsd: values[4],
      inputAudioOverrideUsd: values[5],
      outputAudioOverrideUsd: values[6],
      perCallOverrideUsd: values[7],
    });
  };

  return (
    <div style={{ marginTop: 8, padding: 12, border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', display: 'grid', gap: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, overflowWrap: 'anywhere' }}>编辑规则：{modelId}</div>
      <label style={{ display: 'grid', gap: 6, fontSize: 12 }}>映射模式
        <select aria-label="映射模式" value={mode} onChange={(event) => setMode(event.target.value as 'manual' | 'custom')} style={fieldStyle}>
          <option value="custom">自定义</option><option value="manual">手动映射</option>
        </select>
      </label>
      {mode === 'manual' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <label style={{ display: 'grid', gap: 6, fontSize: 12 }}>Provider
          <input aria-label="官方 Provider" list="pricing-provider-options" value={providerId} onChange={(event) => setProviderId(event.target.value)} style={fieldStyle} />
          <datalist id="pricing-provider-options">{Array.from(new Set(catalog.map((item) => item.providerId))).map((provider) => <option key={provider} value={provider} />)}</datalist>
        </label>
        <label style={{ display: 'grid', gap: 6, fontSize: 12 }}>官方模型
          <input aria-label="官方模型" list="pricing-model-options" value={catalogModelId} onChange={(event) => setCatalogModelId(event.target.value)} style={fieldStyle} />
          <datalist id="pricing-model-options">{catalog.filter((item) => !providerId || item.providerId === providerId).map((item) => <option key={`${item.providerId}/${item.modelId}`} value={item.modelId}>{item.displayName}</option>)}</datalist>
        </label>
      </div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {[
          ['输入覆盖 USD/百万', input, setInput],
          ['输出覆盖 USD/百万', output, setOutput],
          ['缓存读取覆盖 USD/百万', cacheRead, setCacheRead],
          ['缓存写入覆盖 USD/百万', cacheWrite, setCacheWrite],
          ['推理覆盖 USD/百万', reasoning, setReasoning],
          ['输入音频覆盖 USD/百万', inputAudio, setInputAudio],
          ['输出音频覆盖 USD/百万', outputAudio, setOutputAudio],
          ['单次调用覆盖 USD', perCall, setPerCall],
        ].map(([label, value, setter]) => (
          <label key={label as string} style={{ display: 'grid', gap: 6, fontSize: 12 }}>{label as string}
            <input aria-label={label as string} type="number" min={0} step="any" value={value as string} onChange={(event) => (setter as React.Dispatch<React.SetStateAction<string>>)(event.target.value)} placeholder="留空继承" style={fieldStyle} />
          </label>
        ))}
      </div>
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--color-error)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" style={{ minHeight: 44 }} disabled={saving} onClick={submit}>{saving ? '保存中…' : '保存模型规则'}</button>
        <button className="btn btn-ghost" style={{ minHeight: 44 }} disabled={saving} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}
