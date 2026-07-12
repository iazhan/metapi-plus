import { describe, expect, it } from 'vitest';

import { resolveProviderProfile } from './registry.js';

describe('resolveProviderProfile', () => {
  it('does not resolve retired native oauth providers', () => {
    expect(resolveProviderProfile('codex')).toBeNull();
    expect(resolveProviderProfile('gemini-cli')).toBeNull();
    expect(resolveProviderProfile('antigravity')).toBeNull();
  });

  it('builds Claude API-key requests without OAuth headers', () => {
    const profile = resolveProviderProfile('claude');
    const protocolBody = {
      model: 'claude-opus-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    };

    const result = profile!.prepareRequest({
      endpoint: 'messages',
      modelName: 'claude-opus-4-6',
      stream: false,
      tokenValue: 'sk-claude-api-key',
      sitePlatform: 'claude',
      baseHeaders: { 'Content-Type': 'application/json' },
      claudeHeaders: {},
      body: protocolBody,
    });

    expect(result.path).toBe('/v1/messages');
    expect(result.headers.Authorization).toBeUndefined();
    expect(result.headers['x-api-key']).toBe('sk-claude-api-key');
    expect(result.headers['anthropic-version']).toBe('2023-06-01');
    expect(result.headers['anthropic-beta']).not.toContain('oauth-2025-04-20');
    expect(result.body).toBe(protocolBody);
  });

  it('keeps Claude API-key token counting support', () => {
    const result = resolveProviderProfile('claude')!.prepareRequest({
      endpoint: 'messages',
      modelName: 'claude-opus-4-6',
      stream: false,
      action: 'countTokens',
      tokenValue: 'sk-claude-api-key',
      sitePlatform: 'claude',
      baseHeaders: { 'Content-Type': 'application/json' },
      body: { model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(result.path).toBe('/v1/messages/count_tokens?beta=true');
    expect(result.headers['anthropic-beta']).toContain('token-counting-2024-11-01');
  });
});
