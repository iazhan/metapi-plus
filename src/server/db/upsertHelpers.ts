import { db, runtimeDbDialect } from "./index.js";

type UniqueKeyUpsertInput = {
  txDb?: typeof db;
  table: unknown;
  values: Record<string, unknown>;
  sqlitePostgresConflictTarget: unknown;
  set: Record<string, unknown>;
};

/**
 * Runs a single-statement upsert through the dialect-specific Drizzle API.
 *
 * MySQL exposes `onDuplicateKeyUpdate`, while SQLite and PostgreSQL expose
 * `onConflictDoUpdate`. MySQL does not target a specific unique constraint:
 * callers must only use this helper when inserted values can conflict on the
 * intended logical key.
 */
export async function upsertOnIntendedUniqueKey({
  txDb = db,
  table,
  values,
  sqlitePostgresConflictTarget,
  set,
}: UniqueKeyUpsertInput): Promise<void> {
  const insertBuilder = (txDb as any).insert(table).values(values);

  if (runtimeDbDialect === "mysql") {
    await insertBuilder
      .onDuplicateKeyUpdate({
        set,
      })
      .run();
    return;
  }

  await insertBuilder
    .onConflictDoUpdate({
      target: sqlitePostgresConflictTarget,
      set,
    })
    .run();
}
