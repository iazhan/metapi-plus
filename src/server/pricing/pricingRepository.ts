import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertOnIntendedUniqueKey } from '../db/upsertHelpers.js';
import {
  accountGroupRateRuleInputSchema,
  officialModelPriceInputSchema,
  pricingProfileInputSchema,
  siteModelPriceRuleInputSchema,
  sitePriceInputSchema,
  type OfficialModelPriceInput,
  type PricingProfileInput,
  type SiteModelPriceRuleInput,
  type SitePriceInput,
} from './contracts.js';
import { invalidateEffectivePriceCacheEntries } from './effectivePriceCache.js';

export type OfficialModelPriceRow = typeof schema.officialModelPrices.$inferSelect;
export type SiteModelPriceRow = typeof schema.siteModelPrices.$inferSelect;
export type SiteModelPriceRuleRow = typeof schema.siteModelPriceRules.$inferSelect;
export type AccountGroupRateRuleRow = typeof schema.accountGroupRateRules.$inferSelect;
export type PricingRefreshStateRow = typeof schema.pricingRefreshStates.$inferSelect;

const SNAPSHOT_INSERT_BATCH_SIZE = 500;

function assertUniqueSnapshotKeys(rows: string[], label: string): void {
  const seen = new Set<string>();
  for (const key of rows) {
    if (seen.has(key)) throw new Error(`Duplicate ${label} snapshot key: ${key}`);
    seen.add(key);
  }
}

async function insertSnapshotBatches<Row>(
  rows: Row[],
  insertBatch: (batch: Row[]) => Promise<unknown>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += SNAPSHOT_INSERT_BATCH_SIZE) {
    await insertBatch(rows.slice(offset, offset + SNAPSHOT_INSERT_BATCH_SIZE));
  }
}

export async function replaceOfficialPriceSnapshot(rows: OfficialModelPriceInput[]): Promise<void> {
  const normalized = officialModelPriceInputSchema.array().min(1).parse(rows);
  assertUniqueSnapshotKeys(normalized.map((row) => `${row.providerId}\0${row.modelId}`), 'official price');

  await db.transaction(async (tx: typeof db) => {
    await tx.delete(schema.officialModelPrices).run();
    await insertSnapshotBatches(normalized, (batch) => (
      tx.insert(schema.officialModelPrices).values(batch).run()
    ));
  });
  invalidateEffectivePriceCacheEntries();
}

export async function replaceSitePriceSnapshot(siteId: number, rows: SitePriceInput[]): Promise<void> {
  if (!Number.isSafeInteger(siteId) || siteId <= 0) throw new Error('Invalid siteId');
  const normalized = sitePriceInputSchema.array().parse(rows);
  assertUniqueSnapshotKeys(normalized.map((row) => row.upstreamModelId), 'site price');

  await db.transaction(async (tx: typeof db) => {
    await tx.delete(schema.siteModelPrices)
      .where(eq(schema.siteModelPrices.siteId, siteId))
      .run();
    await insertSnapshotBatches(
      normalized.map((row) => ({ ...row, siteId })),
      (batch) => tx.insert(schema.siteModelPrices).values(batch).run(),
    );
  });
  invalidateEffectivePriceCacheEntries({ siteId });
}

export function listOfficialModelPrices(): Promise<OfficialModelPriceRow[]> {
  return db.select().from(schema.officialModelPrices)
    .orderBy(asc(schema.officialModelPrices.providerId), asc(schema.officialModelPrices.modelId))
    .all();
}

export function getOfficialModelPrice(providerId: string, modelId: string): Promise<OfficialModelPriceRow | undefined> {
  return db.select().from(schema.officialModelPrices)
    .where(and(
      eq(schema.officialModelPrices.providerId, providerId),
      eq(schema.officialModelPrices.modelId, modelId),
    ))
    .get();
}

export function listSiteModelPrices(siteId: number): Promise<SiteModelPriceRow[]> {
  return db.select().from(schema.siteModelPrices)
    .where(eq(schema.siteModelPrices.siteId, siteId))
    .orderBy(asc(schema.siteModelPrices.upstreamModelId))
    .all();
}

export function getSiteModelPrice(siteId: number, upstreamModelId: string): Promise<SiteModelPriceRow | undefined> {
  return db.select().from(schema.siteModelPrices)
    .where(and(
      eq(schema.siteModelPrices.siteId, siteId),
      eq(schema.siteModelPrices.upstreamModelId, upstreamModelId),
    ))
    .get();
}

export async function getSitePricingProfile(siteId: number): Promise<PricingProfileInput> {
  const row = await db.select().from(schema.sitePricingProfiles)
    .where(eq(schema.sitePricingProfiles.siteId, siteId))
    .get();
  return row
    ? { paidCny: row.paidCny, creditedUsd: row.creditedUsd }
    : { paidCny: 1, creditedUsd: 1 };
}

export async function upsertSitePricingProfile(siteId: number, input: PricingProfileInput): Promise<void> {
  const normalized = pricingProfileInputSchema.parse(input);
  const now = new Date().toISOString();
  await upsertOnIntendedUniqueKey({
    table: schema.sitePricingProfiles,
    values: { siteId, ...normalized, createdAt: now, updatedAt: now },
    sqlitePostgresConflictTarget: schema.sitePricingProfiles.siteId,
    set: { ...normalized, updatedAt: now },
  });
  invalidateEffectivePriceCacheEntries({ siteId });
}

export async function getSiteModelPriceRule(
  siteId: number,
  upstreamModelId: string,
): Promise<SiteModelPriceRuleRow | null> {
  return (await db.select().from(schema.siteModelPriceRules)
    .where(and(
      eq(schema.siteModelPriceRules.siteId, siteId),
      eq(schema.siteModelPriceRules.upstreamModelId, upstreamModelId),
    ))
    .get()) ?? null;
}

export function listSiteModelPriceRules(siteId: number): Promise<SiteModelPriceRuleRow[]> {
  return db.select().from(schema.siteModelPriceRules)
    .where(eq(schema.siteModelPriceRules.siteId, siteId))
    .orderBy(asc(schema.siteModelPriceRules.upstreamModelId))
    .all();
}

export async function upsertSiteModelPriceRule(
  siteId: number,
  upstreamModelId: string,
  input: SiteModelPriceRuleInput,
): Promise<void> {
  const normalized = siteModelPriceRuleInputSchema.parse(input);
  const now = new Date().toISOString();
  const values = {
    siteId,
    upstreamModelId: upstreamModelId.trim(),
    mappedProviderId: normalized.mappedProviderId ?? null,
    mappedModelId: normalized.mappedModelId ?? null,
    mappingMode: normalized.mappingMode,
    inputOverrideUsd: normalized.inputOverrideUsd ?? null,
    outputOverrideUsd: normalized.outputOverrideUsd ?? null,
    cacheReadOverrideUsd: normalized.cacheReadOverrideUsd ?? null,
    cacheWriteOverrideUsd: normalized.cacheWriteOverrideUsd ?? null,
    reasoningOverrideUsd: normalized.reasoningOverrideUsd ?? null,
    inputAudioOverrideUsd: normalized.inputAudioOverrideUsd ?? null,
    outputAudioOverrideUsd: normalized.outputAudioOverrideUsd ?? null,
    perCallOverrideUsd: normalized.perCallOverrideUsd ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const updatedValues: Partial<typeof values> = { ...values };
  delete updatedValues.createdAt;
  await upsertOnIntendedUniqueKey({
    table: schema.siteModelPriceRules,
    values,
    sqlitePostgresConflictTarget: [
      schema.siteModelPriceRules.siteId,
      schema.siteModelPriceRules.upstreamModelId,
    ],
    set: updatedValues,
  });
  invalidateEffectivePriceCacheEntries({ siteId });
}

export async function deleteSiteModelPriceRule(siteId: number, upstreamModelId: string): Promise<boolean> {
  const result = await db.delete(schema.siteModelPriceRules)
    .where(and(
      eq(schema.siteModelPriceRules.siteId, siteId),
      eq(schema.siteModelPriceRules.upstreamModelId, upstreamModelId),
    ))
    .run();
  invalidateEffectivePriceCacheEntries({ siteId });
  return Number(result.changes ?? 0) > 0;
}

export async function getAccountGroupRateRule(accountId: number, groupKey: string): Promise<AccountGroupRateRuleRow | null> {
  return (await db.select().from(schema.accountGroupRateRules)
    .where(and(
      eq(schema.accountGroupRateRules.accountId, accountId),
      eq(schema.accountGroupRateRules.groupKey, groupKey),
    ))
    .get()) ?? null;
}

export function listAccountGroupRateRules(accountId: number): Promise<AccountGroupRateRuleRow[]> {
  return db.select().from(schema.accountGroupRateRules)
    .where(eq(schema.accountGroupRateRules.accountId, accountId))
    .orderBy(asc(schema.accountGroupRateRules.groupKey))
    .all();
}

export async function upsertAccountGroupRateRule(accountId: number, groupKey: string, ratioOverride: number): Promise<void> {
  const normalized = accountGroupRateRuleInputSchema.parse({ ratioOverride });
  const normalizedGroupKey = groupKey.trim();
  if (!normalizedGroupKey) throw new Error('groupKey is required');
  const now = new Date().toISOString();
  await upsertOnIntendedUniqueKey({
    table: schema.accountGroupRateRules,
    values: { accountId, groupKey: normalizedGroupKey, ...normalized, createdAt: now, updatedAt: now },
    sqlitePostgresConflictTarget: [
      schema.accountGroupRateRules.accountId,
      schema.accountGroupRateRules.groupKey,
    ],
    set: { ...normalized, updatedAt: now },
  });
  invalidateEffectivePriceCacheEntries({ accountId });
}

export async function deleteAccountGroupRateRule(accountId: number, groupKey: string): Promise<boolean> {
  const result = await db.delete(schema.accountGroupRateRules)
    .where(and(
      eq(schema.accountGroupRateRules.accountId, accountId),
      eq(schema.accountGroupRateRules.groupKey, groupKey),
    ))
    .run();
  invalidateEffectivePriceCacheEntries({ accountId });
  return Number(result.changes ?? 0) > 0;
}

export function listPricingRefreshStates(): Promise<PricingRefreshStateRow[]> {
  return db.select().from(schema.pricingRefreshStates)
    .orderBy(asc(schema.pricingRefreshStates.scopeType), asc(schema.pricingRefreshStates.scopeId))
    .all();
}

export function getPricingRefreshState(scopeType: 'official' | 'site', scopeId: number): Promise<PricingRefreshStateRow | undefined> {
  return db.select().from(schema.pricingRefreshStates)
    .where(and(
      eq(schema.pricingRefreshStates.scopeType, scopeType),
      eq(schema.pricingRefreshStates.scopeId, scopeId),
    ))
    .get();
}

export async function upsertPricingRefreshState(
  scopeType: 'official' | 'site',
  scopeId: number,
  patch: Partial<Pick<PricingRefreshStateRow,
    'lastSuccessAt' | 'lastFailureAt' | 'lastFailureKind' | 'failureActive'>>,
): Promise<void> {
  const now = new Date().toISOString();
  const previous = await getPricingRefreshState(scopeType, scopeId);
  const values = {
    scopeType,
    scopeId,
    lastSuccessAt: patch.lastSuccessAt ?? previous?.lastSuccessAt ?? null,
    lastFailureAt: patch.lastFailureAt ?? previous?.lastFailureAt ?? null,
    lastFailureKind: patch.lastFailureKind ?? previous?.lastFailureKind ?? null,
    failureActive: patch.failureActive ?? previous?.failureActive ?? false,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  const updatedValues: Partial<typeof values> = { ...values };
  delete updatedValues.createdAt;
  await upsertOnIntendedUniqueKey({
    table: schema.pricingRefreshStates,
    values,
    sqlitePostgresConflictTarget: [
      schema.pricingRefreshStates.scopeType,
      schema.pricingRefreshStates.scopeId,
    ],
    set: updatedValues,
  });
}
