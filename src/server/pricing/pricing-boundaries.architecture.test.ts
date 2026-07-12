import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('pricing domain architecture boundaries', () => {
  it('keeps proxy billing routes on the pricing-domain billing facade', () => {
    for (const path of [
      '../routes/proxy/completions.ts',
      '../routes/proxy/embeddings.ts',
      '../routes/proxy/images.ts',
      '../routes/proxy/videos.ts',
    ]) {
      const source = readSource(path);
      expect(source).not.toContain('modelPricingService.js');
    }
  });

  it('keeps routing reference costs owned by the pricing domain', () => {
    const source = readSource('../services/tokenRouter.ts');
    expect(source).not.toContain('modelPricingService.js');
    expect(source).toContain("from '../pricing/routingReferenceCost.js'");
  });

  it('keeps legacy aggregate fallback independent from the old pricing service', () => {
    const source = readSource('../services/usageAggregationService.ts');
    expect(source).not.toContain('modelPricingService.js');
  });

  it('keeps marketplace numeric pricing on effective-price results', () => {
    const source = readSource('../routes/api/stats.ts');
    expect(source).toContain('toMarketplaceGroupPricing(price)');
    expect(source).not.toContain('groupPricing: model.groupPricing');
  });

  it('keeps route adapters away from pricing persistence', () => {
    const pricingRoute = readSource('../routes/api/pricing.ts');
    expect(pricingRoute).not.toContain("from '../../db/");
    expect(pricingRoute).not.toContain("from '../../config.js'");
    expect(pricingRoute).toContain("from '../../pricing/pricingAdminService.js'");
    for (const path of ['../routes/proxy/completions.ts', '../routes/proxy/embeddings.ts']) {
      expect(readSource(path)).not.toContain("from '../../db/schema.js'");
    }
  });

  it('uses the shared runtime response reader for whole-body upstream reads', () => {
    const source = readSource('./modelsDevPriceSource.ts');
    expect(source).toContain('readRuntimeResponseText(response)');
    expect(source).not.toContain('response.text()');
  });
});
