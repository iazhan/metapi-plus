import { describe, expect, it } from 'vitest';

import {
  hasVersionedApiPathSuffix,
  stripLeadingVersionSegmentForVersionedBase,
} from './versionedApiPath.js';

describe('versionedApiPath', () => {
  it('detects provider API roots that end with a version segment', () => {
    expect(hasVersionedApiPathSuffix('/v1')).toBe(true);
    expect(hasVersionedApiPathSuffix('/api/v1')).toBe(true);
    expect(hasVersionedApiPathSuffix('/api/coding/v3')).toBe(true);
    expect(hasVersionedApiPathSuffix('/v1beta/openai')).toBe(false);
  });

  it('strips only matching or OpenAI /v1 request prefixes for versioned bases', () => {
    expect(stripLeadingVersionSegmentForVersionedBase('/api/coding/v3', '/v1/chat/completions'))
      .toBe('/chat/completions');
    expect(stripLeadingVersionSegmentForVersionedBase('/api/coding/v3', '/v3/chat/completions'))
      .toBe('/chat/completions');
    expect(stripLeadingVersionSegmentForVersionedBase('/v1beta', '/v1beta/models'))
      .toBe('/models');
    expect(stripLeadingVersionSegmentForVersionedBase('/api/v1', '/v1beta/models'))
      .toBe('/v1beta/models');
  });
});
