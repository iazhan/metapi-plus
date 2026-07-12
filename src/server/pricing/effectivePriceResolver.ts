import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  PRICE_FIELD_KEYS,
  type EffectivePrice,
  type EffectivePriceSources,
  type MappingMode,
  type PriceFieldKey,
  type PriceSource,
  type PricingSemantics,
} from './contracts.js';
import {
  getAccountGroupRateRule,
  getSiteModelPrice,
  getSiteModelPriceRule,
  getSitePricingProfile,
  listOfficialModelPrices,
} from './pricingRepository.js';
import { resolveCatalogMapping } from './siteModelMappingService.js';
import {
  deleteEffectivePriceCacheEntry,
  getEffectivePriceCacheEntry,
  invalidateEffectivePriceCacheEntries,
  setEffectivePriceCacheEntry,
} from './effectivePriceCache.js';

const SITE_FIELD_COLUMNS: Record<PriceFieldKey, keyof typeof schema.siteModelPrices.$inferSelect> = {
  inputPerMillionUsd: 'inputPerMillionUsd',
  outputPerMillionUsd: 'outputPerMillionUsd',
  cacheReadPerMillionUsd: 'cacheReadPerMillionUsd',
  cacheWritePerMillionUsd: 'cacheWritePerMillionUsd',
  reasoningPerMillionUsd: 'reasoningPerMillionUsd',
  inputAudioPerMillionUsd: 'inputAudioPerMillionUsd',
  outputAudioPerMillionUsd: 'outputAudioPerMillionUsd',
  perCallUsd: 'perCallUsd',
};

const RULE_FIELD_COLUMNS: Record<PriceFieldKey, keyof typeof schema.siteModelPriceRules.$inferSelect> = {
  inputPerMillionUsd: 'inputOverrideUsd',
  outputPerMillionUsd: 'outputOverrideUsd',
  cacheReadPerMillionUsd: 'cacheReadOverrideUsd',
  cacheWritePerMillionUsd: 'cacheWriteOverrideUsd',
  reasoningPerMillionUsd: 'reasoningOverrideUsd',
  inputAudioPerMillionUsd: 'inputAudioOverrideUsd',
  outputAudioPerMillionUsd: 'outputAudioOverrideUsd',
  perCallUsd: 'perCallOverrideUsd',
};

const OFFICIAL_FIELD_COLUMNS: Partial<Record<PriceFieldKey, keyof typeof schema.officialModelPrices.$inferSelect>> = {
  inputPerMillionUsd: 'inputPerMillionUsd',
  outputPerMillionUsd: 'outputPerMillionUsd',
  cacheReadPerMillionUsd: 'cacheReadPerMillionUsd',
  cacheWritePerMillionUsd: 'cacheWritePerMillionUsd',
  reasoningPerMillionUsd: 'reasoningPerMillionUsd',
  inputAudioPerMillionUsd: 'inputAudioPerMillionUsd',
  outputAudioPerMillionUsd: 'outputAudioPerMillionUsd',
};

export interface ResolveEffectivePriceInput {
  siteId: number;
  accountId: number;
  tokenGroup: string | null;
  credentialKind?: 'session' | 'api_key';
  upstreamModelId: string;
  providerHint?: string | null;
}

function readNullableNumber(row: object | null | undefined, key: PropertyKey | undefined): number | null {
  if (!row || key === undefined) return null;
  const value = (row as Record<PropertyKey, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function resolveEffectiveGroupRate(
  accountId: number,
  groupKey: string,
): Promise<{ synchronizedRatio: number | null; overrideRatio: number | null; effectiveRatio: number }> {
  const normalizedGroupKey = groupKey.trim() || 'default';
  const [override, synchronized] = await Promise.all([
    getAccountGroupRateRule(accountId, normalizedGroupKey),
    db.select().from(schema.accountGroupRates)
      .where(and(
        eq(schema.accountGroupRates.accountId, accountId),
        eq(schema.accountGroupRates.groupKey, normalizedGroupKey),
      ))
      .get(),
  ]);
  const overrideRatio = override?.ratioOverride ?? null;
  const synchronizedRatio = synchronized?.ratio ?? null;
  return {
    synchronizedRatio,
    overrideRatio,
    effectiveRatio: overrideRatio ?? synchronizedRatio ?? 1,
  };
}

export type EffectiveGroupRateView = {
  groupKey: string;
  groupName: string;
  description: string | null;
  ratio: number;
  lastSyncedAt: string | null;
  synchronizedRatio: number | null;
  overrideRatio: number | null;
  effectiveRatio: number;
};

export async function listEffectiveGroupRates(
  accountId: number,
  requestedGroupKeys: string[] = [],
): Promise<EffectiveGroupRateView[]> {
  const [synchronizedRowsRaw, overrideRowsRaw] = await Promise.all([
    db.select().from(schema.accountGroupRates)
      .where(eq(schema.accountGroupRates.accountId, accountId))
      .orderBy(asc(schema.accountGroupRates.groupKey))
      .all(),
    db.select().from(schema.accountGroupRateRules)
      .where(eq(schema.accountGroupRateRules.accountId, accountId))
      .orderBy(asc(schema.accountGroupRateRules.groupKey))
      .all(),
  ]);
  const synchronizedRows = synchronizedRowsRaw as Array<typeof schema.accountGroupRates.$inferSelect>;
  const overrideRows = overrideRowsRaw as Array<typeof schema.accountGroupRateRules.$inferSelect>;
  const synchronizedByKey = new Map(synchronizedRows.map((row) => [row.groupKey, row]));
  const overrideByKey = new Map(overrideRows.map((row) => [row.groupKey, row]));
  const groupKeys = Array.from(new Set([
    ...requestedGroupKeys.map((value) => value.trim()).filter(Boolean),
    ...synchronizedByKey.keys(),
    ...overrideByKey.keys(),
  ])).sort((left, right) => left.localeCompare(right));

  return groupKeys.map((groupKey) => {
    const synchronized = synchronizedByKey.get(groupKey);
    const override = overrideByKey.get(groupKey);
    const synchronizedRatio = synchronized?.ratio ?? null;
    const overrideRatio = override?.ratioOverride ?? null;
    const effectiveRatio = overrideRatio ?? synchronizedRatio ?? 1;
    return {
      groupKey,
      groupName: synchronized?.groupName || groupKey,
      description: synchronized?.description ?? null,
      ratio: synchronizedRatio ?? effectiveRatio,
      lastSyncedAt: synchronized?.lastSyncedAt ?? null,
      synchronizedRatio,
      overrideRatio,
      effectiveRatio,
    };
  });
}

async function resolveEffectivePriceUncached(input: ResolveEffectivePriceInput): Promise<EffectivePrice> {
  const groupKey = input.credentialKind === 'api_key'
    ? 'default'
    : (input.tokenGroup?.trim() || 'default');
  const [sitePrice, rule, officialCatalog, profile, rate] = await Promise.all([
    getSiteModelPrice(input.siteId, input.upstreamModelId),
    getSiteModelPriceRule(input.siteId, input.upstreamModelId),
    listOfficialModelPrices(),
    getSitePricingProfile(input.siteId),
    resolveEffectiveGroupRate(input.accountId, groupKey),
  ]);
  const mapping = resolveCatalogMapping({
    upstreamModelId: input.upstreamModelId,
    providerHint: input.providerHint,
    catalog: officialCatalog.map((row) => ({ providerId: row.providerId, modelId: row.modelId })),
    rule: rule ? {
      mappingMode: rule.mappingMode as MappingMode,
      mappedProviderId: rule.mappedProviderId,
      mappedModelId: rule.mappedModelId,
    } : null,
  });
  const officialPrice = mapping.status === 'mapped'
    ? officialCatalog.find((row) => row.providerId === mapping.providerId && row.modelId === mapping.modelId) ?? null
    : null;

  const values = {} as Record<PriceFieldKey, number | null>;
  const sources = {} as EffectivePriceSources;
  const semantics = {} as Record<PriceFieldKey, PricingSemantics>;
  for (const field of PRICE_FIELD_KEYS) {
    const manualValue = readNullableNumber(rule, RULE_FIELD_COLUMNS[field]);
    const siteValue = readNullableNumber(sitePrice, SITE_FIELD_COLUMNS[field]);
    const officialValue = readNullableNumber(officialPrice, OFFICIAL_FIELD_COLUMNS[field]);
    let source: PriceSource = 'missing';
    let value: number | null = null;
    let fieldSemantics: PricingSemantics = 'base_price';
    if (manualValue !== null) {
      value = manualValue;
      source = 'manual';
    } else if (siteValue !== null) {
      value = siteValue;
      source = 'site';
      fieldSemantics = sitePrice!.pricingSemantics as PricingSemantics;
    } else if (mapping.status !== 'custom' && officialValue !== null) {
      value = officialValue;
      source = 'models_dev';
    }
    values[field] = value;
    sources[field] = source;
    semantics[field] = fieldSemantics;
  }

  const groupRatioApplied = PRICE_FIELD_KEYS.some((field) => (
    values[field] !== null && semantics[field] !== 'price_includes_group_ratio'
  ));
  return {
    ...values,
    upstreamModelId: input.upstreamModelId,
    providerId: mapping.status === 'mapped' ? mapping.providerId : null,
    catalogModelId: mapping.status === 'mapped' ? mapping.modelId : null,
    mappingSource: mapping.status === 'mapped' ? mapping.source : mapping.status,
    priceSources: sources,
    priceSemantics: semantics,
    pricingSemantics: sitePrice?.pricingSemantics as PricingSemantics ?? 'base_price',
    groupRatio: rate.effectiveRatio,
    groupRatioApplied,
    paidCny: profile.paidCny,
    creditedUsd: profile.creditedUsd,
  };
}

export function resolveEffectivePrice(input: ResolveEffectivePriceInput): Promise<EffectivePrice> {
  const cacheKey = [
    input.siteId,
    input.accountId,
    input.credentialKind ?? 'session',
    input.tokenGroup ?? '',
    input.providerHint ?? '',
    input.upstreamModelId,
  ].join('\0');
  const cached = getEffectivePriceCacheEntry(cacheKey);
  if (cached) return cached;
  const value = resolveEffectivePriceUncached(input).catch((error) => {
    deleteEffectivePriceCacheEntry(cacheKey);
    throw error;
  });
  setEffectivePriceCacheEntry(cacheKey, value);
  return value;
}

export function invalidateEffectivePriceCache(input?: { siteId?: number; accountId?: number }): void {
  invalidateEffectivePriceCacheEntries(input);
}
