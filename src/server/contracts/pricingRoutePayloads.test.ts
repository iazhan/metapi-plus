import { describe, expect, it } from 'vitest';
import {
  parseAccountGroupRateRulePayload,
  parsePricingSettingsPayload,
  parseSiteModelPriceRulePayload,
  parseSitePricingProfilePayload,
} from './pricingRoutePayloads.js';

describe('pricing route payloads', () => {
  it('accepts free prices and rejects invalid finite-number boundaries', () => {
    expect(parseSitePricingProfilePayload({ paidCny: 1, creditedUsd: 10 }).success).toBe(true);
    expect(parseSitePricingProfilePayload({ paidCny: 0, creditedUsd: 10 }).success).toBe(false);
    expect(parseAccountGroupRateRulePayload({ ratioOverride: 0 }).success).toBe(true);
    expect(parseAccountGroupRateRulePayload({ ratioOverride: -1 }).success).toBe(false);
    expect(parseSiteModelPriceRulePayload({
      mappingMode: 'custom',
      inputOverrideUsd: 0,
    }).success).toBe(true);
  });

  it('validates price refresh cron expressions', () => {
    expect(parsePricingSettingsPayload({ enabled: true, cronExpr: '0 0 * * *' }).success).toBe(true);
    expect(parsePricingSettingsPayload({ enabled: true, cronExpr: 'not a cron' }).success).toBe(false);
  });
});
