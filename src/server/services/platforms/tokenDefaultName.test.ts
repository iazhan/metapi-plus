import { describe, expect, it } from 'vitest';
import type { RequestInit as UndiciRequestInit } from 'undici';

import { NewApiAdapter } from './newApi.js';
import { OneApiAdapter } from './oneApi.js';
import { Sub2ApiAdapter } from './sub2api.js';

type CapturedBody = Record<string, unknown>;

function parseRequestBody(options?: UndiciRequestInit): CapturedBody {
  return JSON.parse(String(options?.body || '{}')) as CapturedBody;
}

class CapturingNewApiAdapter extends NewApiAdapter {
  readonly bodies: CapturedBody[] = [];

  protected override async fetchJson<T>(_url: string, options?: UndiciRequestInit): Promise<T> {
    this.bodies.push(parseRequestBody(options));
    return { success: true } as T;
  }
}

class CapturingOneApiAdapter extends OneApiAdapter {
  readonly bodies: CapturedBody[] = [];

  protected override async fetchJson<T>(_url: string, options?: UndiciRequestInit): Promise<T> {
    this.bodies.push(parseRequestBody(options));
    return { success: true } as T;
  }
}

class CapturingSub2ApiAdapter extends Sub2ApiAdapter {
  readonly bodies: CapturedBody[] = [];

  protected override async fetchJson<T>(_url: string, options?: UndiciRequestInit): Promise<T> {
    this.bodies.push(parseRequestBody(options));
    return { code: 0, message: 'success', data: { id: 1, key: 'sk-created' } } as T;
  }
}

describe('platform token default name', () => {
  it('uses metapi-plus when New API token name is omitted', async () => {
    const adapter = new CapturingNewApiAdapter();

    await expect(adapter.createApiToken('https://new-api.example.com', 'session-token', 1)).resolves.toBe(true);
    expect(adapter.bodies).toEqual([expect.objectContaining({ name: 'metapi-plus' })]);
  });

  it('uses metapi-plus when One API token name is omitted', async () => {
    const adapter = new CapturingOneApiAdapter();

    await expect(adapter.createApiToken('https://one-api.example.com', 'session-token')).resolves.toBe(true);
    expect(adapter.bodies).toEqual([expect.objectContaining({ name: 'metapi-plus' })]);
  });

  it('uses metapi-plus when Sub2API key name is omitted', async () => {
    const adapter = new CapturingSub2ApiAdapter();

    await expect(adapter.createApiToken('https://sub2api.example.com', 'session-token')).resolves.toBe(true);
    expect(adapter.bodies).toEqual([expect.objectContaining({ name: 'metapi-plus' })]);
  });
});
