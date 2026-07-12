import cron from 'node-cron';
import { z } from 'zod';
import {
  accountGroupRateRuleInputSchema,
  pricingProfileInputSchema,
  siteModelPriceRuleInputSchema,
} from '../pricing/contracts.js';

const pricingSettingsSchema = z.object({
  enabled: z.boolean(),
  cronExpr: z.string().trim().min(1).refine((value) => cron.validate(value), {
    message: 'Invalid cron expression',
  }),
});

type ParseResult<T> = { success: true; data: T } | { success: false; error: string };

function parse<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  const issue = result.error.issues[0];
  const path = issue?.path.join('.') || 'payload';
  return { success: false, error: `${path}: ${issue?.message || 'Invalid value'}` };
}

export function parsePricingSettingsPayload(input: unknown) {
  return parse(pricingSettingsSchema, input);
}

export function parseSitePricingProfilePayload(input: unknown) {
  return parse(pricingProfileInputSchema, input);
}

export function parseSiteModelPriceRulePayload(input: unknown) {
  return parse(siteModelPriceRuleInputSchema, input);
}

export function parseAccountGroupRateRulePayload(input: unknown) {
  return parse(accountGroupRateRuleInputSchema, input);
}
