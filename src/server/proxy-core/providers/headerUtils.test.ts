import { describe, expect, it } from 'vitest';

describe('provider header utils', () => {
  it('coerces header values and performs case-insensitive lookups', async () => {
    const { headerValueToString, getInputHeader } = await import('./headerUtils.js');

    expect(headerValueToString('  value  ')).toBe('value');
    expect(headerValueToString(['', '  first  ', 'second'])).toBe('first');
    expect(getInputHeader({ Authorization: 'Bearer test' }, 'authorization')).toBe('Bearer test');
  });

  it('merges claude beta headers without duplicating entries', async () => {
    const { mergeClaudeBetaHeader } = await import('./headerUtils.js');

    expect(
      mergeClaudeBetaHeader(null, 'beta-a,beta-b', ['beta-b', 'beta-c']),
    ).toBe('beta-a,beta-b,beta-c');
    expect(
      mergeClaudeBetaHeader('custom-a,custom-b', 'beta-a,beta-b', ['beta-c']),
    ).toBe('beta-a,beta-b,custom-a,custom-b,beta-c');
  });

  it('builds Claude API-key runtime headers with merged betas', async () => {
    const { buildClaudeRuntimeHeaders } = await import('./headerUtils.js');

    const headers = buildClaudeRuntimeHeaders({
      baseHeaders: {
        'Content-Type': 'application/json',
        authorization: 'Bearer stale-token',
      },
      claudeHeaders: {
        'anthropic-beta': 'custom-beta',
        'x-api-key': 'stale-api-key',
        'user-agent': 'custom-agent',
      },
      anthropicVersion: '2023-06-01',
      stream: true,
      tokenValue: 'sk-ant-api-key',
    });

    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-beta']).toContain('claude-code-20250219');
    expect(headers['anthropic-beta']).toContain('fine-grained-tool-streaming-2025-05-14');
    expect(headers['anthropic-beta']).toContain('custom-beta');
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-api-key']).toBe('sk-ant-api-key');
    expect(headers['user-agent']).toBeUndefined();
    expect(headers['User-Agent']).toBe('custom-agent');
    expect(headers.Accept).toBe('text/event-stream');
  });

});
