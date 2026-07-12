import { z } from 'zod';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';
import type { OfficialModelPriceInput } from './contracts.js';
import { officialModelPriceInputSchema } from './contracts.js';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_DEV_TIMEOUT_MS = 15_000;

const priceValueSchema = z.number().finite().nonnegative();
const costSchema = z.object({
  input: priceValueSchema.optional(),
  output: priceValueSchema.optional(),
  cache_read: priceValueSchema.optional(),
  cache_write: priceValueSchema.optional(),
  reasoning: priceValueSchema.optional(),
  input_audio: priceValueSchema.optional(),
  output_audio: priceValueSchema.optional(),
  tiers: z.array(z.record(z.string(), z.unknown())).optional(),
  context_over_200k: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const modelSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  last_updated: z.string().trim().min(1).optional(),
  cost: costSchema.optional(),
}).passthrough();

const providerSchema = z.object({
  id: z.string().trim().min(1).optional(),
  models: z.record(z.string(), modelSchema),
}).passthrough();

const catalogSchema = z.record(z.string(), providerSchema);

function nullablePrice(value: number | undefined): number | null {
  return value ?? null;
}

export function parseModelsDevPayload(payload: unknown, fetchedAt: string): OfficialModelPriceInput[] {
  const parsed = catalogSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Invalid models.dev catalog: ${parsed.error.issues[0]?.message || 'invalid payload'}`);
  }
  const providerEntries = Object.entries(parsed.data);
  if (providerEntries.length === 0) throw new Error('Empty models.dev catalog');

  const rows: OfficialModelPriceInput[] = [];
  for (const [providerKey, provider] of providerEntries) {
    const providerId = provider.id || providerKey;
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const cost = model.cost;
      const tierMetadata = cost?.tiers || cost?.context_over_200k
        ? JSON.stringify({
            ...(cost.tiers ? { tiers: cost.tiers } : {}),
            ...(cost.context_over_200k ? { contextOver200k: cost.context_over_200k } : {}),
          })
        : null;
      const row = officialModelPriceInputSchema.parse({
        providerId,
        modelId: model.id || modelKey,
        displayName: model.name,
        inputPerMillionUsd: nullablePrice(cost?.input),
        outputPerMillionUsd: nullablePrice(cost?.output),
        cacheReadPerMillionUsd: nullablePrice(cost?.cache_read),
        cacheWritePerMillionUsd: nullablePrice(cost?.cache_write),
        reasoningPerMillionUsd: nullablePrice(cost?.reasoning),
        inputAudioPerMillionUsd: nullablePrice(cost?.input_audio),
        outputAudioPerMillionUsd: nullablePrice(cost?.output_audio),
        tiersJson: tierMetadata,
        sourceUpdatedAt: model.last_updated ?? null,
        fetchedAt,
      });
      rows.push(row);
    }
  }
  if (rows.length === 0) throw new Error('Empty models.dev model catalog');
  return rows;
}

export async function fetchModelsDevPrices(signal?: AbortSignal): Promise<OfficialModelPriceInput[]> {
  const { fetch } = await import('undici');
  const timeoutSignal = AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(MODELS_DEV_API_URL, { signal: requestSignal });
  if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
  const rawText = await readRuntimeResponseText(response);
  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new Error('Invalid models.dev JSON response');
  }
  return parseModelsDevPayload(payload, new Date().toISOString());
}
