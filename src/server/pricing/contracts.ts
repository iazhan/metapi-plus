import { z } from 'zod';

export const PRICE_FIELD_KEYS = [
  'inputPerMillionUsd',
  'outputPerMillionUsd',
  'cacheReadPerMillionUsd',
  'cacheWritePerMillionUsd',
  'reasoningPerMillionUsd',
  'inputAudioPerMillionUsd',
  'outputAudioPerMillionUsd',
  'perCallUsd',
] as const;

export const TOKEN_PRICE_FIELD_KEYS = PRICE_FIELD_KEYS.filter(
  (key) => key !== 'perCallUsd',
) as Exclude<PriceFieldKey, 'perCallUsd'>[];

export type PriceFieldKey = typeof PRICE_FIELD_KEYS[number];
export type PricingSemantics = 'base_price' | 'price_includes_group_ratio' | 'model_ratio';
export type PriceSource = 'manual' | 'site' | 'models_dev' | 'missing';
export type MappingMode = 'manual' | 'custom';

export interface PricingCredential {
  kind: 'session' | 'api_key';
  value: string;
  platformUserId?: number;
}

const nullablePriceSchema = z.number().finite().nonnegative().nullable().optional();
const priceShape = Object.fromEntries(
  PRICE_FIELD_KEYS.map((key) => [key, nullablePriceSchema]),
) as Record<PriceFieldKey, typeof nullablePriceSchema>;

export const pricingProfileInputSchema = z.object({
  paidCny: z.number().finite().positive(),
  creditedUsd: z.number().finite().positive(),
});

export const accountGroupRateRuleInputSchema = z.object({
  ratioOverride: z.number().finite().nonnegative(),
});

export const siteModelPriceRuleInputSchema = z.object({
  mappingMode: z.enum(['manual', 'custom']),
  mappedProviderId: z.string().trim().min(1).nullable().optional(),
  mappedModelId: z.string().trim().min(1).nullable().optional(),
  inputOverrideUsd: nullablePriceSchema,
  outputOverrideUsd: nullablePriceSchema,
  cacheReadOverrideUsd: nullablePriceSchema,
  cacheWriteOverrideUsd: nullablePriceSchema,
  reasoningOverrideUsd: nullablePriceSchema,
  inputAudioOverrideUsd: nullablePriceSchema,
  outputAudioOverrideUsd: nullablePriceSchema,
  perCallOverrideUsd: nullablePriceSchema,
}).superRefine((value, context) => {
  const hasProvider = typeof value.mappedProviderId === 'string';
  const hasModel = typeof value.mappedModelId === 'string';
  if (value.mappingMode === 'manual' && (!hasProvider || !hasModel)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mappedModelId'],
      message: 'manual mapping requires mappedProviderId and mappedModelId',
    });
  }
  if (value.mappingMode === 'custom' && (hasProvider || hasModel)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mappedProviderId'],
      message: 'custom mapping cannot reference an official model',
    });
  }
});

export const officialModelPriceInputSchema = z.object({
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  inputPerMillionUsd: nullablePriceSchema,
  outputPerMillionUsd: nullablePriceSchema,
  cacheReadPerMillionUsd: nullablePriceSchema,
  cacheWritePerMillionUsd: nullablePriceSchema,
  reasoningPerMillionUsd: nullablePriceSchema,
  inputAudioPerMillionUsd: nullablePriceSchema,
  outputAudioPerMillionUsd: nullablePriceSchema,
  tiersJson: z.string().nullable().optional(),
  sourceUpdatedAt: z.string().nullable().optional(),
  fetchedAt: z.string().datetime(),
});

export const sitePriceInputSchema = z.object({
  upstreamModelId: z.string().trim().min(1),
  ...priceShape,
  pricingSemantics: z.enum(['base_price', 'price_includes_group_ratio', 'model_ratio']),
  rawMetadataJson: z.string().nullable().optional(),
  fetchedAt: z.string().datetime(),
});

export type PricingProfileInput = z.infer<typeof pricingProfileInputSchema>;
export type AccountGroupRateRuleInput = z.infer<typeof accountGroupRateRuleInputSchema>;
export type SiteModelPriceRuleInput = z.infer<typeof siteModelPriceRuleInputSchema>;
export type OfficialModelPriceInput = z.infer<typeof officialModelPriceInputSchema>;
export type SitePriceInput = z.infer<typeof sitePriceInputSchema>;
export type PlatformPriceQuote = Omit<SitePriceInput, 'fetchedAt'>;

export type EffectivePriceFields = Record<PriceFieldKey, number | null>;
export type EffectivePriceSources = Record<PriceFieldKey, PriceSource>;

export interface EffectivePrice extends EffectivePriceFields {
  upstreamModelId: string;
  providerId: string | null;
  catalogModelId: string | null;
  mappingSource: 'manual' | 'exact' | 'date_suffix' | 'custom' | 'unmapped';
  priceSources: EffectivePriceSources;
  priceSemantics: Record<PriceFieldKey, PricingSemantics>;
  pricingSemantics: PricingSemantics;
  groupRatio: number;
  groupRatioApplied: boolean;
  paidCny: number;
  creditedUsd: number;
}

export interface PricingBillingSnapshot {
  currency: 'CNY';
  priceSources: EffectivePriceSources;
  providerId: string | null;
  catalogModelId: string | null;
  upstreamModelId: string;
  inputPerMillionUsd: number | null;
  outputPerMillionUsd: number | null;
  cacheReadPerMillionUsd: number | null;
  cacheWritePerMillionUsd: number | null;
  reasoningPerMillionUsd: number | null;
  inputAudioPerMillionUsd: number | null;
  outputAudioPerMillionUsd: number | null;
  perCallUsd: number | null;
  groupRatio: number;
  groupRatioApplied: boolean;
  paidCny: number;
  creditedUsd: number;
  siteCostUsd: number;
  actualCostCny: number;
  pricedAt: string;
}
