import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { GroupRateInfo } from './platforms/base.js';
import { invalidateEffectivePriceCacheEntries } from '../pricing/effectivePriceCache.js';

export type AccountGroupRate = typeof schema.accountGroupRates.$inferSelect;

export function normalizeGroupRate(rate: unknown, index = 0): GroupRateInfo {
  if (!rate || typeof rate !== 'object') {
    throw new Error(`Invalid group rate at index ${index}: expected an object`);
  }

  const candidate = rate as Partial<GroupRateInfo>;
  const groupKey = typeof candidate.groupKey === 'string' ? candidate.groupKey.trim() : '';
  if (!groupKey) {
    throw new Error(`Invalid group rate at index ${index}: groupKey is required`);
  }
  if (typeof candidate.ratio !== 'number' || !Number.isFinite(candidate.ratio) || candidate.ratio < 0) {
    throw new Error(`Invalid group rate at index ${index}: ratio must be a non-negative number`);
  }
  if (candidate.groupName != null && typeof candidate.groupName !== 'string') {
    throw new Error(`Invalid group rate at index ${index}: groupName must be a string`);
  }
  if (candidate.description != null && typeof candidate.description !== 'string') {
    throw new Error(`Invalid group rate at index ${index}: description must be a string`);
  }

  return {
    groupKey,
    groupName: String(candidate.groupName || '').trim() || groupKey,
    description: String(candidate.description || '').trim() || null,
    ratio: candidate.ratio,
  };
}

function normalizeGroupRates(rates: GroupRateInfo[]): GroupRateInfo[] {
  if (!Array.isArray(rates)) {
    throw new Error('Invalid group rate snapshot: expected an array');
  }

  const byGroupKey = new Map<string, GroupRateInfo>();

  for (let index = 0; index < rates.length; index += 1) {
    const normalized = normalizeGroupRate(rates[index], index);
    byGroupKey.set(normalized.groupKey, normalized);
  }

  return [...byGroupKey.values()];
}

async function replaceNormalizedAccountGroupRates(
  tx: typeof db,
  accountId: number,
  normalizedRates: GroupRateInfo[],
  lastSyncedAt: string,
): Promise<void> {
  await tx.delete(schema.accountGroupRates)
    .where(eq(schema.accountGroupRates.accountId, accountId))
    .run();

  if (normalizedRates.length === 0) return;

  await tx.insert(schema.accountGroupRates)
    .values(normalizedRates.map((rate) => ({
      accountId,
      groupKey: rate.groupKey,
      groupName: rate.groupName,
      description: rate.description,
      ratio: rate.ratio,
      lastSyncedAt,
      createdAt: lastSyncedAt,
      updatedAt: lastSyncedAt,
    })))
    .run();
}

/**
 * 原子替换单个账号的倍率快照。调用方只有在成功取得完整上游结果后才应调用。
 */
export async function replaceAccountGroupRates(
  accountId: number,
  rates: GroupRateInfo[],
  lastSyncedAt = new Date().toISOString(),
): Promise<{ total: number }> {
  const normalizedRates = normalizeGroupRates(rates);

  await db.transaction(async (tx: typeof db) => {
    await replaceNormalizedAccountGroupRates(tx, accountId, normalizedRates, lastSyncedAt);
  });
  invalidateEffectivePriceCacheEntries({ accountId });

  return { total: normalizedRates.length };
}

export async function replaceAccountGroupRatesForSession(
  accountId: number,
  expectedAccessToken: string,
  expectedExtraConfig: string | null,
  rates: GroupRateInfo[],
  lastSyncedAt = new Date().toISOString(),
): Promise<{ status: 'persisted'; total: number } | { status: 'stale' }> {
  const normalizedRates = normalizeGroupRates(rates);

  const result = await db.transaction(async (tx: typeof db) => {
    const account = await tx.select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    const status = String(account?.status || 'active').trim().toLowerCase() || 'active';
    if (
      !account
      || status === 'disabled'
      || account.accessToken !== expectedAccessToken
      || (account.extraConfig ?? null) !== expectedExtraConfig
    ) {
      return { status: 'stale' as const };
    }

    const claimedStatus = status === 'expired' ? 'active' : account.status;
    const claim = await tx.update(schema.accounts)
      .set({ status: claimedStatus, updatedAt: lastSyncedAt })
      .where(and(
        eq(schema.accounts.id, accountId),
        or(
          isNull(schema.accounts.status),
          inArray(schema.accounts.status, ['active', 'expired']),
        ),
        account.status === null
          ? isNull(schema.accounts.status)
          : eq(schema.accounts.status, account.status),
        eq(schema.accounts.accessToken, expectedAccessToken),
        expectedExtraConfig === null
          ? isNull(schema.accounts.extraConfig)
          : eq(schema.accounts.extraConfig, expectedExtraConfig),
      ))
      .run();
    if (Number(claim?.changes || 0) !== 1) {
      return { status: 'stale' as const };
    }

    await replaceNormalizedAccountGroupRates(tx, accountId, normalizedRates, lastSyncedAt);

    return { status: 'persisted' as const, total: normalizedRates.length };
  });
  if (result.status === 'persisted') invalidateEffectivePriceCacheEntries({ accountId });
  return result;
}

export async function listAccountGroupRates(accountId: number): Promise<AccountGroupRate[]> {
  return db.select()
    .from(schema.accountGroupRates)
    .where(eq(schema.accountGroupRates.accountId, accountId))
    .orderBy(asc(schema.accountGroupRates.groupKey))
    .all();
}
