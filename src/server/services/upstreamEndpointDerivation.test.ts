import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchModelPricingCatalogMock = vi.fn(async (_arg?: unknown): Promise<any> => null);

vi.mock('./modelPricingService.js', () => ({
  fetchModelPricingCatalog: (arg: unknown) => fetchModelPricingCatalogMock(arg),
}));

import { resolveUpstreamEndpointCandidates } from './upstreamEndpointDerivation.js';
import {
  recordUpstreamEndpointSuccess,
  resetUpstreamEndpointRuntimeState,
} from './upstreamEndpointRuntimeMemory.js';

const baseContext = {
  site: {
    id: 1,
    url: 'https://upstream.example.com',
    platform: 'new-api',
    apiKey: null,
  },
  account: {
    id: 2,
    accessToken: 'token-demo',
    apiToken: null,
  },
};

describe('upstreamEndpointDerivation', () => {
  beforeEach(() => {
    fetchModelPricingCatalogMock.mockReset();
    fetchModelPricingCatalogMock.mockResolvedValue(null);
    resetUpstreamEndpointRuntimeState();
  });

  it('derives compact requests directly to responses from the service owner', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'responses',
      undefined,
      undefined,
      {
        requestKind: 'responses-compact',
      },
    );

    expect(order).toEqual(['responses']);
  });

  it('derives codex oauth openai requests as responses-first without surface-local reordering', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
      undefined,
      undefined,
      {
        oauthProvider: 'codex',
      },
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
  });

  it('keeps explicit openai platforms on responses-first ordering even for claude-family models', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
        },
      },
      'claude-opus-4-6',
      'openai',
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
  });

  it('prefers chat first for known Coding Plan OpenAI endpoints', async () => {
    const cases = [
      'https://coding.dashscope.aliyuncs.com',
      'https://coding.dashscope.aliyuncs.com/v1',
      'https://open.bigmodel.cn/api/coding/paas/v4',
      'https://ark.cn-beijing.volces.com/api/coding/v3',
    ];

    for (const url of cases) {
      const order = await resolveUpstreamEndpointCandidates(
        {
          ...baseContext,
          site: {
            ...baseContext.site,
            platform: 'openai',
            url,
          },
        },
        'ark-code-latest',
        'openai',
      );

      expect(order).toEqual(['chat', 'responses', 'messages']);
    }
  });

  it('keeps Coding Plan chat-first ordering even when runtime memory prefers responses', async () => {
    recordUpstreamEndpointSuccess({
      siteId: baseContext.site.id,
      endpoint: 'responses',
      downstreamFormat: 'openai',
      modelName: 'ark-code-latest',
    });

    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
          url: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        },
      },
      'ark-code-latest',
      'openai',
    );

    expect(order).toEqual(['chat', 'responses', 'messages']);
  });

  it('keeps antigravity non-gemini compatibility requests on messages-first ordering', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'antigravity',
        },
      },
      'claude-opus-4-6',
      'openai',
      undefined,
      {
        hasNonImageFileInput: true,
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('keeps claude-family file-url requests messages-first for claude upstreams', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'claude',
        },
      },
      'claude-opus-4-6',
      'responses',
      undefined,
      {
        hasNonImageFileInput: true,
      },
      {
        requiresNativeResponsesFileUrl: true,
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('derives claude count_tokens requests as messages-only when the upstream supports messages', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
        },
      },
      'claude-sonnet-4-5-20250929',
      'claude',
      undefined,
      undefined,
      {
        requestKind: 'claude-count-tokens',
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('returns no candidates for claude count_tokens when the upstream does not support messages', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'codex',
          url: 'https://chatgpt.com/backend-api/codex',
        },
      },
      'gpt-5.4',
      'claude',
      undefined,
      undefined,
      {
        requestKind: 'claude-count-tokens',
      },
    );

    expect(order).toEqual([]);
  });
});
