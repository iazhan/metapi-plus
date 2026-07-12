import { describe, expect, it } from 'vitest';

import {
  ensureCompactResponsesJsonAcceptHeader,
  sanitizeCompactResponsesRequestBody,
  shouldForceResponsesUpstreamStream,
} from './responsesCompact.js';

describe('sanitizeCompactResponsesRequestBody', () => {
  it('removes store from sub2api compact requests', () => {
    expect(sanitizeCompactResponsesRequestBody({
      stream: true,
      stream_options: { include_obfuscation: true },
      store: false,
      input: 'hello',
    }, {
      sitePlatform: 'sub2api',
    })).toEqual({
      input: 'hello',
    });
  });

  it('keeps store for unrelated compact platforms while still removing stream fields', () => {
    expect(sanitizeCompactResponsesRequestBody({
      stream: true,
      stream_options: { include_obfuscation: true },
      store: false,
      input: 'hello',
    }, {
      sitePlatform: 'openai',
    })).toEqual({
      store: false,
      input: 'hello',
    });
  });
});

describe('shouldForceResponsesUpstreamStream', () => {
  it('forces non-compact responses streaming for sub2api', () => {
    expect(shouldForceResponsesUpstreamStream({
      sitePlatform: 'sub2api',
      isCompactRequest: false,
    })).toBe(true);
  });

  it('does not force compact or unrelated platforms', () => {
    expect(shouldForceResponsesUpstreamStream({
      sitePlatform: 'sub2api',
      isCompactRequest: true,
    })).toBe(false);
    expect(shouldForceResponsesUpstreamStream({
      sitePlatform: 'openai',
      isCompactRequest: false,
    })).toBe(false);
  });
});

describe('ensureCompactResponsesJsonAcceptHeader', () => {
  it('adds application/json accept for sub2api compact requests when missing', () => {
    expect(ensureCompactResponsesJsonAcceptHeader({}, {
      sitePlatform: 'sub2api',
    })).toEqual({
      accept: 'application/json',
    });
  });

  it('forces compact requests back to application/json even when callers asked for SSE', () => {
    expect(ensureCompactResponsesJsonAcceptHeader({
      Accept: 'text/event-stream',
    }, {
      sitePlatform: 'sub2api',
    })).toEqual({
      accept: 'application/json',
    });
  });

  it('preserves unrelated platforms', () => {
    expect(ensureCompactResponsesJsonAcceptHeader({}, {
      sitePlatform: 'openai',
    })).toEqual({});
  });
});
