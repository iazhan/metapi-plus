import { beforeEach, describe, expect, it, vi } from "vitest";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const adminSnapshots = sqliteTable("admin_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  namespace: text("namespace").notNull(),
  snapshotKey: text("snapshot_key").notNull(),
  payload: text("payload").notNull(),
  generatedAt: text("generated_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  staleUntil: text("stale_until").notNull(),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

const schema = {
  adminSnapshots,
};

type MockState = {
  values: Record<string, unknown> | null;
  duplicateKeyUpdate: { set: Record<string, unknown> } | null;
  conflictUpdate: unknown;
  runCount: number;
};

const state: MockState = {
  values: null,
  duplicateKeyUpdate: null,
  conflictUpdate: null,
  runCount: 0,
};

function resetMockState() {
  state.values = null;
  state.duplicateKeyUpdate = null;
  state.conflictUpdate = null;
  state.runCount = 0;
  vi.clearAllMocks();
}

function makeInsertChain() {
  const chain = {
    values(nextValues: Record<string, unknown>) {
      state.values = nextValues;
      return chain;
    },
    onDuplicateKeyUpdate(input: { set: Record<string, unknown> }) {
      state.duplicateKeyUpdate = input;
      return chain;
    },
    onConflictDoUpdate(input: unknown) {
      state.conflictUpdate = input;
      return chain;
    },
    run: vi.fn(async () => {
      state.runCount += 1;
      return { changes: 1 };
    }),
  };

  return chain;
}

const db = {
  insert: vi.fn(() => makeInsertChain()),
};

vi.mock("../db/index.js", () => ({
  db,
  runtimeDbDialect: "mysql",
  schema,
}));

type AdminSnapshotStoreModule = typeof import("./adminSnapshotStore.js");

describe("adminSnapshotStore mysql conflict handling", () => {
  let writeAdminSnapshot: AdminSnapshotStoreModule["writeAdminSnapshot"];

  beforeEach(async () => {
    resetMockState();
    vi.resetModules();
    ({ writeAdminSnapshot } = await import("./adminSnapshotStore.js"));
  });

  it("uses mysql duplicate-key upsert for snapshot writes", async () => {
    await writeAdminSnapshot(
      { namespace: "dashboard-summary", key: "default" },
      {
        payload: { totalBalance: 12.5, totalAccounts: 3 },
        generatedAt: "2026-04-09T00:00:00.000Z",
        expiresAt: "2026-04-09T00:00:10.000Z",
        staleUntil: "2026-04-09T00:01:00.000Z",
      },
    );

    const updatedAt = state.values?.updatedAt;
    expect(updatedAt).toEqual(expect.any(String));
    expect(db.insert).toHaveBeenCalledWith(adminSnapshots);
    expect(state.values).toEqual(expect.objectContaining({
      namespace: "dashboard-summary",
      snapshotKey: JSON.stringify("default"),
      payload: JSON.stringify({ totalBalance: 12.5, totalAccounts: 3 }),
      generatedAt: "2026-04-09T00:00:00.000Z",
      expiresAt: "2026-04-09T00:00:10.000Z",
      staleUntil: "2026-04-09T00:01:00.000Z",
    }));
    expect(state.duplicateKeyUpdate).toEqual({
      set: {
        payload: JSON.stringify({ totalBalance: 12.5, totalAccounts: 3 }),
        generatedAt: "2026-04-09T00:00:00.000Z",
        expiresAt: "2026-04-09T00:00:10.000Z",
        staleUntil: "2026-04-09T00:01:00.000Z",
        updatedAt,
      },
    });
    expect(state.conflictUpdate).toBeNull();
    expect(state.runCount).toBe(1);
  });
});
