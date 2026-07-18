import { describe, expect, it } from 'vitest';
import { validateSiteModelAliases } from './siteModelAliasService.js';

describe('validateSiteModelAliases', () => {
  it('normalizes a valid alias and defaults it to enabled', () => {
    expect(validateSiteModelAliases([
      { sourceModel: '  GPT-4O  ', aliasModel: '  fast-model  ' },
    ])).toEqual({
      success: true,
      aliases: [{
        sourceModel: 'GPT-4O',
        aliasModel: 'fast-model',
        enabled: true,
        sourceKey: 'gpt-4o',
        aliasKey: 'fast-model',
      }],
    });
  });

  it('trims names and rejects case-insensitive duplicate aliases', () => {
    const result = validateSiteModelAliases([
      { sourceModel: '  gpt-4o  ', aliasModel: '  Fast  ' },
      { sourceModel: 'claude-sonnet', aliasModel: 'fast' },
    ]);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'duplicate_alias',
        message: 'Duplicate alias model: fast',
        index: 1,
      },
    });
  });

  it('rejects case-insensitive self aliases', () => {
    const result = validateSiteModelAliases([
      { sourceModel: ' GPT-4O ', aliasModel: 'gpt-4o' },
    ]);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'self_alias',
        message: 'Alias model must differ from source model: gpt-4o',
        index: 0,
      },
    });
  });

  it('rejects alias chains that cycle after normalization', () => {
    const result = validateSiteModelAliases([
      { sourceModel: 'Model-A', aliasModel: 'Model-B' },
      { sourceModel: ' model-b ', aliasModel: 'MODEL-C' },
      { sourceModel: 'model-c', aliasModel: 'model-a' },
    ]);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'alias_cycle',
        message: 'Model alias cycle detected: model-b -> model-a -> model-c -> model-b',
        index: 0,
      },
    });
  });

  it('rejects aliases that collide with canonical model names', () => {
    const result = validateSiteModelAliases(
      [{ sourceModel: 'upstream-model', aliasModel: ' Public-Model ' }],
      { reservedModelNames: ['public-model'] },
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'canonical_conflict',
        message: 'Alias model conflicts with a canonical model: Public-Model',
        index: 0,
      },
    });
  });

  it('rejects alias-to-alias chains even when they are acyclic', () => {
    const result = validateSiteModelAliases([
      { sourceModel: 'real-model', aliasModel: 'alias-one' },
      { sourceModel: 'ALIAS-ONE', aliasModel: 'alias-two' },
    ]);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'alias_chain',
        message: 'Alias sources must be canonical models: ALIAS-ONE',
        index: 1,
      },
    });
  });

  it.each(['model-*', 'model?', 're:^model'])('rejects pattern-like alias names: %s', (aliasModel) => {
    expect(validateSiteModelAliases([
      { sourceModel: 'real-model', aliasModel },
    ])).toEqual({
      success: false,
      error: {
        code: 'invalid_alias',
        message: `Alias model must be an exact model name: ${aliasModel}`,
        index: 0,
      },
    });
  });

  it.each(['model-*', 'model?', 're:^model'])('rejects pattern-like source model names: %s', (sourceModel) => {
    expect(validateSiteModelAliases([
      { sourceModel, aliasModel: 'public-model' },
    ])).toEqual({
      success: false,
      error: {
        code: 'invalid_alias',
        message: `Source model must be an exact model name: ${sourceModel}`,
        index: 0,
      },
    });
  });

  it('accepts square brackets as literal characters in exact model names', () => {
    expect(validateSiteModelAliases([
      { sourceModel: '[NV]deepseek-v3.1-terminus', aliasModel: '[team]deepseek-stable' },
    ])).toEqual({
      success: true,
      aliases: [{
        sourceModel: '[NV]deepseek-v3.1-terminus',
        aliasModel: '[team]deepseek-stable',
        enabled: true,
        sourceKey: '[nv]deepseek-v3.1-terminus',
        aliasKey: '[team]deepseek-stable',
      }],
    });
  });

  it.each([
    { sourceModel: 's'.repeat(192), aliasModel: 'alias' },
    { sourceModel: 'source', aliasModel: 'a'.repeat(192) },
  ])('rejects model names longer than 191 characters', (mapping) => {
    expect(validateSiteModelAliases([mapping])).toEqual({
      success: false,
      error: {
        code: 'invalid_alias',
        message: 'Model names must be at most 191 characters.',
        index: 0,
      },
    });
  });

  it.each([
    { sourceModel: 'source\u0001model', aliasModel: 'alias' },
    { sourceModel: 'source', aliasModel: 'alias\u007fmodel' },
  ])('rejects control characters in model names', (mapping) => {
    expect(validateSiteModelAliases([mapping])).toEqual({
      success: false,
      error: {
        code: 'invalid_alias',
        message: 'Model names cannot contain control characters.',
        index: 0,
      },
    });
  });
});
