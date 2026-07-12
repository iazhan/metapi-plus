export type TokenGroupRateMeta = {
  groupKey: string;
  groupName: string;
  ratio: number;
  description?: string | null;
  lastSyncedAt?: string | null;
};

type TokenGroupLike = {
  tokenGroup?: string | null;
  groupRate?: TokenGroupRateMeta | null;
};

function normalizeGroupKey(value: unknown): string {
  return String(value || '').trim();
}

function formatRateLabel(groupKey: string, rate?: TokenGroupRateMeta | null): string {
  const ratio = Number(rate?.ratio);
  if (!rate || !Number.isFinite(ratio) || ratio < 0) return groupKey;
  const groupName = String(rate.groupName || '').trim() || groupKey;
  return `${groupName} · ${ratio}x`;
}

export function formatTokenGroupLabel(token: TokenGroupLike): string {
  const groupKey = normalizeGroupKey(token.tokenGroup) || 'default';
  const rate = normalizeGroupKey(token.groupRate?.groupKey) === groupKey
    ? token.groupRate
    : null;
  return formatRateLabel(groupKey, rate);
}

export function buildTokenGroupOptions(
  groups: unknown[],
  rates: TokenGroupRateMeta[],
): Array<{ value: string; label: string }> {
  const rateByGroupKey = new Map(
    rates
      .map((rate) => [normalizeGroupKey(rate.groupKey), rate] as const)
      .filter(([groupKey]) => groupKey.length > 0),
  );
  const groupKeys = Array.from(new Set([
    ...groups.map(normalizeGroupKey).filter(Boolean),
    ...rateByGroupKey.keys(),
  ]));
  const normalizedKeys = groupKeys.length > 0 ? groupKeys : ['default'];

  return normalizedKeys.map((groupKey) => ({
    value: groupKey,
    label: formatRateLabel(groupKey, rateByGroupKey.get(groupKey)),
  }));
}
