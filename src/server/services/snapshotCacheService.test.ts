import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSnapshotCache,
  invalidateSnapshotCache,
  readSnapshotCache,
  type PersistedSnapshotRecord,
} from "./snapshotCacheService.js";

describe("snapshotCacheService", () => {
  let previousVitestEnv: string | undefined;

  beforeEach(() => {
    previousVitestEnv = process.env.VITEST;
    delete process.env.VITEST;
    clearSnapshotCache();
  });

  afterEach(() => {
    if (previousVitestEnv === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = previousVitestEnv;
    }
  });

  it("degrades persistence read and write failures without breaking the read path", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await readSnapshotCache({
      namespace: "test",
      key: "persistence-failure",
      ttlMs: 1000,
      loader: async () => ({ ok: true }),
      persistence: {
        read: async () => {
          throw new Error("read failed");
        },
        write: async () => {
          throw new Error("write failed");
        },
      },
    });

    expect(result.payload).toEqual({ ok: true });
    expect(result.cacheStatus).toBe("miss");
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("reuses an in-flight loader after async hydration misses", async () => {
    let loaderCalls = 0;
    const persistenceRead = vi.fn(async (): Promise<PersistedSnapshotRecord<number> | null> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return null;
    });

    const [left, right] = await Promise.all([
      readSnapshotCache({
        namespace: "test",
        key: "coalesce",
        ttlMs: 1000,
        loader: async () => {
          loaderCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 42;
        },
        persistence: {
          read: persistenceRead,
          write: async () => {},
        },
      }),
      readSnapshotCache({
        namespace: "test",
        key: "coalesce",
        ttlMs: 1000,
        loader: async () => {
          loaderCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 42;
        },
        persistence: {
          read: persistenceRead,
          write: async () => {},
        },
      }),
    ]);

    expect(left.payload).toBe(42);
    expect(right.payload).toBe(42);
    expect(loaderCalls).toBe(1);
  });

  it("does not let an invalidated in-flight load overwrite a newer snapshot", async () => {
    let resolveOldLoad!: (value: string) => void;
    const oldLoad = new Promise<string>((resolve) => {
      resolveOldLoad = resolve;
    });

    const oldRequest = readSnapshotCache({
      namespace: "test",
      key: "invalidation-race",
      ttlMs: 1000,
      loader: async () => oldLoad,
    });
    await Promise.resolve();

    clearSnapshotCache("test");
    const freshRequest = await readSnapshotCache({
      namespace: "test",
      key: "invalidation-race",
      ttlMs: 1000,
      loader: async () => "fresh",
    });
    expect(freshRequest.payload).toBe("fresh");

    resolveOldLoad("stale");
    await oldRequest;

    const cachedRequest = await readSnapshotCache({
      namespace: "test",
      key: "invalidation-race",
      ttlMs: 1000,
      loader: async () => "unexpected-reload",
    });
    expect(cachedRequest.payload).toBe("fresh");
    expect(cachedRequest.cacheStatus).toBe("hit");
  });

  it("reloads after an existing in-flight request when refresh is forced", async () => {
    let resolveOldLoad!: (value: string) => void;
    const oldLoad = new Promise<string>((resolve) => {
      resolveOldLoad = resolve;
    });

    const oldRequest = readSnapshotCache({
      namespace: "test",
      key: "forced-refresh-race",
      ttlMs: 1000,
      loader: async () => oldLoad,
    });
    await Promise.resolve();

    const forcedRequest = readSnapshotCache({
      namespace: "test",
      key: "forced-refresh-race",
      ttlMs: 1000,
      forceRefresh: true,
      loader: async () => "fresh",
    });

    resolveOldLoad("stale");
    await oldRequest;

    const forcedResult = await forcedRequest;
    expect(forcedResult.payload).toBe("fresh");
    expect(forcedResult.cacheStatus).toBe("refresh");
  });

  it("waits for an invalidated persistence write before completing", async () => {
    let resolveWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });

    const oldRequest = readSnapshotCache({
      namespace: "test",
      key: "persistence-invalidation-race",
      ttlMs: 1000,
      loader: async () => "stale",
      persistence: {
        read: async () => null,
        write: async () => {
          markWriteStarted();
          await pendingWrite;
        },
      },
    });
    await writeStarted;

    let invalidationCompleted = false;
    const invalidation = invalidateSnapshotCache("test").then(() => {
      invalidationCompleted = true;
    });
    const stateBeforeWriteCompletes = await Promise.race([
      invalidation.then(() => "completed" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);
    expect(stateBeforeWriteCompletes).toBe("pending");
    expect(invalidationCompleted).toBe(false);

    resolveWrite();
    await Promise.all([oldRequest, invalidation]);
    expect(invalidationCompleted).toBe(true);
  });
});
