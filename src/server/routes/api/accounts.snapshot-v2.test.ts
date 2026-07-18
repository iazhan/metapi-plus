import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  formatLocalDate,
  formatUtcSqlDateTime,
} from "../../services/localTimeService.js";
import { clearSnapshotCache } from "../../services/snapshotCacheService.js";
import { createTestDataDir, type TestDataDir } from "../../test-fixtures/testDataDir.js";

type DbModule = typeof import("../../db/index.js");

describe("accounts snapshot v2", () => {
  let app: FastifyInstance;
  let db: DbModule["db"];
  let schema: DbModule["schema"];
  let closeDbConnections: DbModule["closeDbConnections"];
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir("metapi-accounts-snapshot-v2-");

    await import("../../db/migrate.js");
    const dbModule = await import("../../db/index.js");
    const routesModule = await import("./accounts.js");
    const sitesRoutesModule = await import("./sites.js");
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
    await app.register(sitesRoutesModule.sitesRoutes);
  });

  beforeEach(async () => {
    clearSnapshotCache("accounts-snapshot");
    await db.delete(schema.adminSnapshots).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    await testDataDir.cleanup(closeDbConnections);
  });

  it("returns accounts and sites in one snapshot payload", async () => {
    const today = formatLocalDate(new Date());
    const site = await db
      .insert(schema.sites)
      .values({
        name: "snapshot-site",
        url: "https://snapshot-site.example.com",
        platform: "new-api",
      })
      .returning()
      .get();

    const account = await db
      .insert(schema.accounts)
      .values({
        siteId: site.id,
        username: "snapshot-user",
        accessToken: "snapshot-token",
        status: "active",
        balance: 18.5,
        extraConfig: JSON.stringify({
          todayIncomeSnapshot: {
            day: today,
            baseline: 3.2,
            latest: 3.2,
            updatedAt: `${today}T08:00:00.000Z`,
          },
        }),
      })
      .returning()
      .get();

    await db
      .insert(schema.proxyLogs)
      .values({
        accountId: account.id,
        status: "success",
        estimatedCost: 1.25,
        createdAt: formatUtcSqlDateTime(new Date()),
      })
      .run();

    await db
      .insert(schema.checkinLogs)
      .values({
        accountId: account.id,
        status: "success",
        reward: "",
        message: "checkin success",
        createdAt: `${today} 09:00:00`,
      })
      .run();

    const response = await app.inject({
      method: "GET",
      url: "/api/accounts",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-accounts-snapshot-cache"]).toBeTruthy();
    const body = response.json() as {
      generatedAt: string;
      accounts: Array<{
        id: number;
        site: { id: number; name: string };
        todaySpend: number;
        todayReward: number;
      }>;
      sites: Array<{ id: number; name: string }>;
    };

    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    expect(body.sites).toEqual([
      expect.objectContaining({ id: site.id, name: "snapshot-site" }),
    ]);
    expect(body.accounts).toEqual([
      expect.objectContaining({
        id: account.id,
        site: expect.objectContaining({ id: site.id, name: "snapshot-site" }),
        todaySpend: 1.25,
        todayReward: 3.2,
      }),
    ]);
  });

  it("immediately includes a site created after the accounts snapshot was cached", async () => {
    const previousVitestEnv = process.env.VITEST;
    delete process.env.VITEST;

    try {
      const warmResponse = await app.inject({
        method: "GET",
        url: "/api/accounts",
      });
      expect(warmResponse.statusCode).toBe(200);
      expect(warmResponse.headers["x-accounts-snapshot-cache"]).toBe("miss");

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sites",
        payload: {
          name: "newly-created-site",
          url: "https://newly-created-site.example.com",
          platform: "new-api",
        },
      });
      expect(createResponse.statusCode).toBe(200);
      const createdSite = createResponse.json() as { id: number };

      const immediateResponse = await app.inject({
        method: "GET",
        url: "/api/accounts",
      });
      expect(immediateResponse.statusCode).toBe(200);
      const immediateBody = immediateResponse.json() as {
        sites: Array<{ id: number; name: string }>;
      };
      expect(immediateBody.sites).toEqual([
        expect.objectContaining({
          id: createdSite.id,
          name: "newly-created-site",
        }),
      ]);
    } finally {
      clearSnapshotCache("accounts-snapshot");
      if (previousVitestEnv === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitestEnv;
    }
  });
});
