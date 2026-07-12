import type { PlatformPriceQuote } from './contracts.js';

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function readNonNegative(value: unknown, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function nullableNonNegative(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  return readNonNegative(value, label);
}

function emptyPrices() {
  return {
    reasoningPerMillionUsd: null,
    inputAudioPerMillionUsd: null,
    outputAudioPerMillionUsd: null,
  };
}

export function normalizeNewApiPricingPayload(payload: unknown): PlatformPriceQuote[] {
  const envelope = assertRecord(payload, 'new-api pricing payload');
  const source = 'data' in envelope ? envelope.data : payload;
  if (!Array.isArray(source)) throw new Error('Invalid new-api pricing list');

  return source.map((raw, index) => {
    const item = assertRecord(raw, `new-api pricing item ${index}`);
    const upstreamModelId = typeof item.model_name === 'string' ? item.model_name.trim() : '';
    if (!upstreamModelId) throw new Error(`Invalid new-api pricing item ${index}: model_name`);
    const quotaType = readNonNegative(item.quota_type, `quota_type for ${upstreamModelId}`, 0);
    if (quotaType === 0) {
      const modelRatio = readNonNegative(item.model_ratio, `model_ratio for ${upstreamModelId}`, 1);
      const completionRatio = readNonNegative(item.completion_ratio, `completion_ratio for ${upstreamModelId}`, 1);
      const cacheRatio = readNonNegative(item.cache_ratio ?? item.cacheRatio, `cache_ratio for ${upstreamModelId}`, 1);
      const cacheWriteRatio = readNonNegative(
        item.cache_creation_ratio ?? item.cacheCreationRatio ?? item.create_cache_ratio,
        `cache_creation_ratio for ${upstreamModelId}`,
        1,
      );
      const inputPerMillionUsd = modelRatio * 2;
      return {
        upstreamModelId,
        inputPerMillionUsd,
        outputPerMillionUsd: inputPerMillionUsd * completionRatio,
        cacheReadPerMillionUsd: inputPerMillionUsd * cacheRatio,
        cacheWritePerMillionUsd: inputPerMillionUsd * cacheWriteRatio,
        ...emptyPrices(),
        perCallUsd: null,
        pricingSemantics: 'model_ratio' as const,
        rawMetadataJson: JSON.stringify({ basis: 'new_api_quota_500000_per_usd', quotaType }),
      };
    }
    if (quotaType !== 1) throw new Error(`Invalid quota_type for ${upstreamModelId}`);
    const modelPrice = item.model_price;
    const perCallUsd = typeof modelPrice === 'number'
      ? readNonNegative(modelPrice, `model_price for ${upstreamModelId}`)
      : readNonNegative(assertRecord(modelPrice, `model_price for ${upstreamModelId}`).input, `model_price.input for ${upstreamModelId}`) * 0.002;
    return {
      upstreamModelId,
      inputPerMillionUsd: null,
      outputPerMillionUsd: null,
      cacheReadPerMillionUsd: null,
      cacheWritePerMillionUsd: null,
      ...emptyPrices(),
      perCallUsd,
      pricingSemantics: 'model_ratio' as const,
      rawMetadataJson: JSON.stringify({ basis: 'new_api_per_call', quotaType }),
    };
  });
}

export function normalizeOneHubPricingPayload(payload: unknown): PlatformPriceQuote[] {
  const envelope = assertRecord(payload, 'one-hub pricing payload');
  const source = assertRecord('data' in envelope ? envelope.data : payload, 'one-hub pricing map');
  return Object.entries(source).map(([upstreamModelId, raw]) => {
    const item = assertRecord(raw, `one-hub model ${upstreamModelId}`);
    const price = assertRecord(item.price, `one-hub price ${upstreamModelId}`);
    const pricingType = typeof price.type === 'string' ? price.type.trim().toLowerCase() : '';
    const input = readNonNegative(price.input, `one-hub input ${upstreamModelId}`);
    if (pricingType === 'tokens') {
      return {
        upstreamModelId,
        inputPerMillionUsd: input,
        outputPerMillionUsd: readNonNegative(price.output, `one-hub output ${upstreamModelId}`, input),
        cacheReadPerMillionUsd: nullableNonNegative(
          price.input_cache_read ?? price.inputCacheRead ?? price.cache_read,
          `one-hub cache read ${upstreamModelId}`,
        ),
        cacheWritePerMillionUsd: nullableNonNegative(
          price.input_cache_write ?? price.inputCacheWrite ?? price.cache_write,
          `one-hub cache write ${upstreamModelId}`,
        ),
        ...emptyPrices(),
        perCallUsd: null,
        pricingSemantics: 'base_price' as const,
        rawMetadataJson: JSON.stringify({ basis: 'one_hub_absolute_tokens', pricingType }),
      };
    }
    if (pricingType === 'times') {
      return {
        upstreamModelId,
        inputPerMillionUsd: null,
        outputPerMillionUsd: null,
        cacheReadPerMillionUsd: null,
        cacheWritePerMillionUsd: null,
        ...emptyPrices(),
        perCallUsd: input * 0.002,
        pricingSemantics: 'model_ratio' as const,
        rawMetadataJson: JSON.stringify({ basis: 'one_hub_ratio_0_002_per_call', pricingType }),
      };
    }
    throw new Error(`Unsupported pricing type for ${upstreamModelId}`);
  });
}
