import { describe, expect, it, vi } from 'vitest';
import { NewApiAdapter } from '../services/platforms/newApi.js';
import { OneHubAdapter } from '../services/platforms/oneHub.js';

describe('platform pricing capability', () => {
  it('fetches and normalizes new-api pricing with the selected credential', async () => {
    const adapter = new NewApiAdapter() as NewApiAdapter & { fetchJson: ReturnType<typeof vi.fn> };
    adapter.fetchJson = vi.fn().mockResolvedValue({
      data: [{ model_name: 'gpt', quota_type: 0, model_ratio: 1, completion_ratio: 2 }],
    });
    const controller = new AbortController();

    const quotes = await adapter.getPricing!(
      'https://site.example.com',
      { kind: 'api_key', value: 'secret' },
      controller.signal,
    );

    expect(quotes[0]).toMatchObject({ upstreamModelId: 'gpt', inputPerMillionUsd: 2 });
    expect(adapter.fetchJson).toHaveBeenCalledWith(
      'https://site.example.com/api/pricing',
      expect.objectContaining({
        signal: controller.signal,
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      }),
    );
  });

  it('fetches one-hub available-model prices and preserves abort propagation', async () => {
    const adapter = new OneHubAdapter() as OneHubAdapter & { fetchJson: ReturnType<typeof vi.fn> };
    adapter.fetchJson = vi.fn().mockResolvedValue({
      data: { claude: { price: { type: 'tokens', input: 3, output: 15 } } },
    });
    const controller = new AbortController();

    const quotes = await adapter.getPricing!(
      'https://onehub.example.com',
      { kind: 'session', value: 'session-secret' },
      controller.signal,
    );

    expect(quotes[0]).toMatchObject({ upstreamModelId: 'claude', pricingSemantics: 'base_price' });
    expect(adapter.fetchJson).toHaveBeenCalledWith(
      'https://onehub.example.com/api/available_model',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
