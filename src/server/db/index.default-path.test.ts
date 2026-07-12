import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

type DbModule = typeof import('./index.js');

describe('sqlite default path resolution', () => {
  const originalDataDir = process.env.DATA_DIR;
  const originalDbUrl = process.env.DB_URL;
  const originalVitestDataRoot = process.env.METAPI_VITEST_DATA_ROOT;
  const originalVitestPoolId = process.env.VITEST_POOL_ID;
  let dbModule: DbModule | null = null;

  afterEach(async () => {
    if (dbModule) {
      await dbModule.closeDbConnections();
      dbModule = null;
    }
    const restoreEnv = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restoreEnv('DATA_DIR', originalDataDir);
    restoreEnv('DB_URL', originalDbUrl);
    restoreEnv('METAPI_VITEST_DATA_ROOT', originalVitestDataRoot);
    restoreEnv('VITEST_POOL_ID', originalVitestPoolId);
    vi.resetModules();
  });

  it('uses an isolated temp sqlite path under vitest when no db env is configured', async () => {
    delete process.env.DATA_DIR;
    delete process.env.DB_URL;
    vi.resetModules();

    dbModule = await import('./index.js');
    const sqlitePath = dbModule.__dbProxyTestUtils.resolveSqlitePath();
    const sharedRepoPath = resolve('./data/hub.db');

    expect(sqlitePath).not.toBe(sharedRepoPath);
    expect(sqlitePath).toContain(tmpdir());
    expect(sqlitePath).toContain('metapi-vitest');
  });

  it('still honors explicit DATA_DIR when provided', async () => {
    process.env.DATA_DIR = resolve(tmpdir(), 'metapi-explicit-data-dir');
    delete process.env.DB_URL;
    vi.resetModules();

    dbModule = await import('./index.js');
    const sqlitePath = dbModule.__dbProxyTestUtils.resolveSqlitePath();

    expect(sqlitePath).toBe(resolve(process.env.DATA_DIR, 'hub.db'));
  });

  it('uses the setup-injected worker database for migrations and runtime access', async () => {
    expect(originalDataDir).toBeTruthy();
    expect(originalVitestDataRoot).toBeTruthy();
    if (!originalDataDir || !originalVitestDataRoot) {
      throw new Error('Expected Vitest worker setup to inject an isolated data directory');
    }

    process.env.DATA_DIR = originalDataDir;
    delete process.env.DB_URL;
    vi.resetModules();

    const migrateModule = await import('./migrate.js');
    const resolveMigrationPath = (
      migrateModule.__migrateTestUtils as Record<string, unknown>
    ).resolveSqliteDbPath;
    expect(resolveMigrationPath).toBeTypeOf('function');
    if (typeof resolveMigrationPath !== 'function') {
      throw new Error('Expected migration path resolver to be exposed for contract tests');
    }

    dbModule = await import('./index.js');
    const migrationPath = resolveMigrationPath() as string;
    const runtimePath = dbModule.__dbProxyTestUtils.resolveSqlitePath();

    expect(resolve(originalDataDir)).not.toBe(resolve(originalVitestDataRoot));
    expect(migrationPath).toBe(resolve(originalDataDir, 'hub.db'));
    expect(runtimePath).toBe(migrationPath);
  });

  it('ignores the default repo DATA_DIR under vitest and still isolates sqlite', async () => {
    process.env.DATA_DIR = './data';
    delete process.env.DB_URL;
    vi.resetModules();

    dbModule = await import('./index.js');
    const sqlitePath = dbModule.__dbProxyTestUtils.resolveSqlitePath();
    const sharedRepoPath = resolve('./data/hub.db');

    expect(sqlitePath).not.toBe(sharedRepoPath);
    expect(sqlitePath).toContain(tmpdir());
    expect(sqlitePath).toContain('metapi-vitest');
  });
});
