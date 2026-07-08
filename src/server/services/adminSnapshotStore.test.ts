import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDataDir, type TestDataDir } from "../test-fixtures/testDataDir.js";

type DbModule = typeof import("../db/index.js");
type AdminSnapshotStoreModule = typeof import("./adminSnapshotStore.js");

describe("adminSnapshotStore", () => {
  let db: DbModule["db"];
  let schema: DbModule["schema"];
  let closeDbConnections: DbModule["closeDbConnections"];
  let readAdminSnapshot: AdminSnapshotStoreModule["readAdminSnapshot"];
  let writeAdminSnapshot: AdminSnapshotStoreModule["writeAdminSnapshot"];
  let deleteExpiredAdminSnapshots: AdminSnapshotStoreModule["deleteExpiredAdminSnapshots"];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir("metapi-admin-snapshot-store-");

    await import("../db/migrate.js");
    const dbModule = await import("../db/index.js");
    const storeModule = await import("./adminSnapshotStore.js");
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    readAdminSnapshot = storeModule.readAdminSnapshot;
    writeAdminSnapshot = storeModule.writeAdminSnapshot;
    deleteExpiredAdminSnapshots = storeModule.deleteExpiredAdminSnapshots;
  });

  beforeEach(async () => {
    await db.delete(schema.adminSnapshots).run();
  });

  afterAll(async () => {
    await testDataDir.cleanup(closeDbConnections);
  });

  it("persists and reloads admin snapshot payloads from the runtime database", async () => {
    await writeAdminSnapshot(
      { namespace: "dashboard-summary", key: "default" },
      {
        payload: { totalBalance: 12.5, totalAccounts: 3 },
        generatedAt: "2026-04-09T00:00:00.000Z",
        expiresAt: "2026-04-09T00:00:10.000Z",
        staleUntil: "2026-04-09T00:01:00.000Z",
      },
    );

    const record = await readAdminSnapshot<{
      totalBalance: number;
      totalAccounts: number;
    }>({
      namespace: "dashboard-summary",
      key: "default",
    });

    expect(record).toEqual({
      payload: { totalBalance: 12.5, totalAccounts: 3 },
      generatedAt: "2026-04-09T00:00:00.000Z",
      expiresAt: "2026-04-09T00:00:10.000Z",
      staleUntil: "2026-04-09T00:01:00.000Z",
    });
  });

  it("updates existing snapshot rows for the same namespace and key", async () => {
    const identity = { namespace: "dashboard-summary", key: "default" };

    await writeAdminSnapshot(identity, {
      payload: { totalBalance: 12.5, totalAccounts: 3 },
      generatedAt: "2026-04-09T00:00:00.000Z",
      expiresAt: "2026-04-09T00:00:10.000Z",
      staleUntil: "2026-04-09T00:01:00.000Z",
    });

    const initialRows = await db.select().from(schema.adminSnapshots).all();
    expect(initialRows).toHaveLength(1);
    const initialRow = initialRows[0];

    await writeAdminSnapshot(identity, {
      payload: { totalBalance: 24, totalAccounts: 5 },
      generatedAt: "2026-04-09T00:02:00.000Z",
      expiresAt: "2026-04-09T00:02:10.000Z",
      staleUntil: "2026-04-09T00:03:00.000Z",
    });

    const rows = await db.select().from(schema.adminSnapshots).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(initialRow?.id);
    expect(rows[0]?.createdAt).toBe(initialRow?.createdAt);

    const record = await readAdminSnapshot<{
      totalBalance: number;
      totalAccounts: number;
    }>(identity);

    expect(record).toEqual({
      payload: { totalBalance: 24, totalAccounts: 5 },
      generatedAt: "2026-04-09T00:02:00.000Z",
      expiresAt: "2026-04-09T00:02:10.000Z",
      staleUntil: "2026-04-09T00:03:00.000Z",
    });
  });

  it("prunes snapshot rows whose stale window has elapsed", async () => {
    await writeAdminSnapshot(
      { namespace: "dashboard-summary", key: "expired" },
      {
        payload: { stale: true },
        generatedAt: "2026-04-09T00:00:00.000Z",
        expiresAt: "2026-04-09T00:00:10.000Z",
        staleUntil: "2026-04-09T00:00:11.000Z",
      },
    );
    await writeAdminSnapshot(
      { namespace: "dashboard-summary", key: "fresh" },
      {
        payload: { stale: false },
        generatedAt: "2026-04-09T00:00:00.000Z",
        expiresAt: "2026-04-09T00:00:10.000Z",
        staleUntil: "2026-04-09T00:10:00.000Z",
      },
    );

    await deleteExpiredAdminSnapshots("2026-04-09T00:05:00.000Z");

    const rows = await db.select().from(schema.adminSnapshots).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.snapshotKey).toBe(JSON.stringify("fresh"));
  });
});
