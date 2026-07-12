import { describe, expect, it } from 'vitest';
import { normalizeLogicalColumnType } from './schemaMetadata.js';

describe('schema metadata pricing fields', () => {
  it('keeps mapping discriminators as text while preserving mapping payloads as json', () => {
    expect(normalizeLogicalColumnType({
      declaredType: 'text',
      columnName: 'mapping_mode',
      dialect: 'sqlite',
    })).toBe('text');
    expect(normalizeLogicalColumnType({
      declaredType: 'text',
      columnName: 'model_mapping',
      dialect: 'sqlite',
    })).toBe('json');
  });
});
