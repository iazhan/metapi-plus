import {
  PRICE_FIELD_KEYS,
  type EffectivePrice,
  type PriceFieldKey,
  type PricingBillingSnapshot,
} from './contracts.js';
import {
  resolveEffectivePrice,
  type ResolveEffectivePriceInput,
} from './effectivePriceResolver.js';

export interface BillingSnapshotInput extends ResolveEffectivePriceInput {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  promptTokensIncludeCache?: boolean | null;
}

export interface BillingSnapshotDependencies {
  resolveEffectivePrice?: (input: ResolveEffectivePriceInput) => Promise<EffectivePrice>;
  now?: () => Date;
}

function tokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Builds an immutable snapshot from one resolver result; it never re-reads current prices. */
export async function buildBillingSnapshot(
  input: BillingSnapshotInput,
  deps: BillingSnapshotDependencies = {},
): Promise<PricingBillingSnapshot | null> {
  const effective = await (deps.resolveEffectivePrice ?? resolveEffectivePrice)(input);
  const cacheReadTokens = tokenCount(input.cacheReadTokens);
  const cacheWriteTokens = tokenCount(input.cacheWriteTokens);
  const rawPromptTokens = tokenCount(input.promptTokens);
  const billablePromptTokens = input.promptTokensIncludeCache
    ? Math.max(0, rawPromptTokens - cacheReadTokens - cacheWriteTokens)
    : rawPromptTokens;
  const usageByField: Partial<Record<PriceFieldKey, number>> = {
    inputPerMillionUsd: billablePromptTokens,
    outputPerMillionUsd: tokenCount(input.completionTokens),
    cacheReadPerMillionUsd: cacheReadTokens,
    cacheWritePerMillionUsd: cacheWriteTokens,
    reasoningPerMillionUsd: tokenCount(input.reasoningTokens),
    inputAudioPerMillionUsd: tokenCount(input.inputAudioTokens),
    outputAudioPerMillionUsd: tokenCount(input.outputAudioTokens),
  };

  let siteCostUsd = 0;
  let hasApplicablePrice = false;
  let groupRatioApplied = false;
  for (const field of PRICE_FIELD_KEYS) {
    const price = effective[field];
    const usage = field === 'perCallUsd' ? 1 : (usageByField[field] ?? 0);
    if (usage <= 0 || price === null) continue;
    hasApplicablePrice = true;
    const applyGroupRatio = effective.priceSemantics[field] !== 'price_includes_group_ratio';
    const ratio = applyGroupRatio ? effective.groupRatio : 1;
    if (applyGroupRatio) groupRatioApplied = true;
    siteCostUsd += field === 'perCallUsd'
      ? price * ratio
      : (usage / 1_000_000) * price * ratio;
  }
  if (!hasApplicablePrice) return null;

  return {
    currency: 'CNY',
    priceSources: effective.priceSources,
    providerId: effective.providerId,
    catalogModelId: effective.catalogModelId,
    upstreamModelId: effective.upstreamModelId,
    inputPerMillionUsd: effective.inputPerMillionUsd,
    outputPerMillionUsd: effective.outputPerMillionUsd,
    cacheReadPerMillionUsd: effective.cacheReadPerMillionUsd,
    cacheWritePerMillionUsd: effective.cacheWritePerMillionUsd,
    reasoningPerMillionUsd: effective.reasoningPerMillionUsd,
    inputAudioPerMillionUsd: effective.inputAudioPerMillionUsd,
    outputAudioPerMillionUsd: effective.outputAudioPerMillionUsd,
    perCallUsd: effective.perCallUsd,
    groupRatio: effective.groupRatio,
    groupRatioApplied,
    paidCny: effective.paidCny,
    creditedUsd: effective.creditedUsd,
    siteCostUsd,
    actualCostCny: siteCostUsd * effective.paidCny / effective.creditedUsd,
    pricedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}
