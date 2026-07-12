import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export type AccountSessionSnapshot = typeof schema.accounts.$inferSelect;
type AccountRow = AccountSessionSnapshot;

type PersistRecoveredAccountSessionInput = {
  account: AccountRow;
  accessToken: string;
  mergeExtraConfig: (latestExtraConfig: string | null) => string;
  signal?: AbortSignal;
};

export type PersistedRecoveredAccountSession = {
  account: AccountRow;
  accessToken: string;
  extraConfig: string;
};

function nullableEquals(column: any, value: string | null): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

export function normalizeAccountSessionStatus(value?: string | null): string {
  return String(value || 'active').trim().toLowerCase() || 'active';
}

export function sessionSnapshotMatches(latest: AccountSessionSnapshot, snapshot: AccountSessionSnapshot): boolean {
  return latest.siteId === snapshot.siteId
    && String(latest.username || '') === String(snapshot.username || '')
    && String(latest.accessToken || '') === String(snapshot.accessToken || '')
    && (latest.extraConfig ?? null) === (snapshot.extraConfig ?? null)
    && normalizeAccountSessionStatus(latest.status) === normalizeAccountSessionStatus(snapshot.status);
}

/**
 * Persists a recovered session only while the account's session-bearing fields still match the caller's snapshot.
 */
export async function persistRecoveredAccountSession(
  input: PersistRecoveredAccountSessionInput,
): Promise<PersistedRecoveredAccountSession | null> {
  input.signal?.throwIfAborted();
  return db.transaction(async (tx: typeof db) => {
    input.signal?.throwIfAborted();
    const latest = await tx.select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, input.account.id))
      .get();
    input.signal?.throwIfAborted();
    if (!latest || normalizeAccountSessionStatus(latest.status) === 'disabled') return null;
    if (!sessionSnapshotMatches(latest, input.account)) return null;

    const extraConfig = input.mergeExtraConfig(latest.extraConfig ?? null);
    input.signal?.throwIfAborted();
    const nextStatus = normalizeAccountSessionStatus(latest.status) === 'expired' ? 'active' : latest.status;
    const updatedAt = new Date().toISOString();
    const result = await tx.update(schema.accounts)
      .set({
        accessToken: input.accessToken,
        extraConfig,
        status: nextStatus,
        updatedAt,
      })
      .where(and(
        eq(schema.accounts.id, latest.id),
        eq(schema.accounts.siteId, latest.siteId),
        nullableEquals(schema.accounts.username, latest.username ?? null),
        eq(schema.accounts.accessToken, latest.accessToken),
        nullableEquals(schema.accounts.extraConfig, latest.extraConfig ?? null),
        nullableEquals(schema.accounts.status, latest.status ?? null),
        nullableEquals(schema.accounts.updatedAt, latest.updatedAt ?? null),
      ))
      .run();
    input.signal?.throwIfAborted();
    if (Number(result?.changes || 0) !== 1) return null;

    return {
      account: { ...latest, accessToken: input.accessToken, extraConfig, status: nextStatus, updatedAt },
      accessToken: input.accessToken,
      extraConfig,
    };
  });
}
