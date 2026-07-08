import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataDir, type TestDataDir } from '../test-fixtures/testDataDir.js';

type DbModule = typeof import('./index.js');
type InsertHelpersModule = typeof import('./insertHelpers.js');

describe('insert helpers', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let insertHelpers: InsertHelpersModule;
  let testDataDir: TestDataDir;

  beforeAll(async () => {
    testDataDir = createTestDataDir('metapi-insert-helpers-');
    await import('./migrate.js');
    const dbModule = await import('./index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    insertHelpers = await import('./insertHelpers.js');
  });

  beforeEach(async () => {
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await testDataDir.cleanup(closeDbConnections);
  });

  it('extracts positive inserted ids from run results', () => {
    expect(insertHelpers.getInsertedRowId({ changes: 1, lastInsertRowid: 12 })).toBe(12);
    expect(insertHelpers.getInsertedRowId({ changes: 1, lastInsertRowid: 0 })).toBeNull();
    expect(insertHelpers.getInsertedRowId(null)).toBeNull();
  });

  it('throws when a required inserted id is missing', () => {
    expect(() => insertHelpers.requireInsertedRowId({ changes: 1, lastInsertRowid: 0 }, 'missing insert id'))
      .toThrow('missing insert id');
  });

  it('inserts and reloads rows through the shared helper', async () => {
    const created = await insertHelpers.insertAndGetById({
      table: schema.sites,
      idColumn: schema.sites.id,
      values: {
        name: 'Shared helper site',
        url: 'https://shared-helper.example.com',
        platform: 'codex',
        status: 'active',
        useSystemProxy: false,
        isPinned: false,
        globalWeight: 1,
        sortOrder: 0,
      },
      insertErrorMessage: 'insert site failed',
      loadErrorMessage: 'load site failed',
    });

    expect(created).toMatchObject({
      id: expect.any(Number),
      name: 'Shared helper site',
      url: 'https://shared-helper.example.com',
      platform: 'codex',
    });
  });
});
