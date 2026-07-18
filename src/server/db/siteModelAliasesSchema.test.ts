import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SchemaContract } from './schemaContract.js';

const dbDir = dirname(fileURLToPath(import.meta.url));
const generatedDir = resolve(dbDir, 'generated');

describe('site model alias schema artifacts', () => {
  it('keeps alias identity, enablement, route ownership, and site cascade aligned across dialects', () => {
    const contract = JSON.parse(
      readFileSync(resolve(generatedDir, 'schemaContract.json'), 'utf8'),
    ) as SchemaContract;

    expect(contract.tables.site_model_aliases?.columns).toMatchObject({
      site_id: { logicalType: 'integer', notNull: true },
      source_model: { logicalType: 'text', notNull: true },
      alias_model: { logicalType: 'text', notNull: true },
      alias_key: { logicalType: 'text', notNull: true },
      enabled: { logicalType: 'boolean', notNull: true, defaultValue: 'true' },
    });
    expect(contract.tables.token_routes?.columns.route_kind).toMatchObject({
      logicalType: 'text',
      notNull: false,
    });
    expect(contract.uniques).toContainEqual({
      name: 'site_model_aliases_site_alias_key_unique',
      table: 'site_model_aliases',
      columns: ['site_id', 'alias_key'],
    });
    expect(contract.foreignKeys).toContainEqual({
      table: 'site_model_aliases',
      columns: ['site_id'],
      referencedTable: 'sites',
      referencedColumns: ['id'],
      onDelete: 'CASCADE',
    });

    for (const dialect of ['mysql', 'postgres']) {
      const bootstrap = readFileSync(resolve(generatedDir, `${dialect}.bootstrap.sql`), 'utf8');
      const upgrade = readFileSync(resolve(generatedDir, `${dialect}.upgrade.sql`), 'utf8');
      expect(bootstrap).toContain('site_model_aliases');
      expect(bootstrap).toContain('route_kind');
      expect(upgrade).toContain('site_model_aliases');
      expect(upgrade).toContain('route_kind');
    }
  });
});
