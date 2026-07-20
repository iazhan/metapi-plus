import type {
  LegacyProxyLogBillingDetails,
  PricingDomainBillingDetails,
  ProxyLogListItem,
} from '../../api.js';

export type ProxyLogDisplayUsage = {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function getCompleteBillingDetails(
  log: ProxyLogListItem,
): LegacyProxyLogBillingDetails | null {
  const detail = log.billingDetails;
  if (!detail) return null;
  if (!('usage' in detail) || !('pricing' in detail) || !('breakdown' in detail)) return null;

  const requiredNumbers = [
    detail.usage.promptTokens,
    detail.usage.completionTokens,
    detail.usage.totalTokens,
    detail.usage.cacheReadTokens,
    detail.usage.cacheCreationTokens,
    detail.usage.billablePromptTokens,
    detail.pricing.modelRatio,
    detail.pricing.completionRatio,
    detail.pricing.cacheRatio,
    detail.pricing.cacheCreationRatio,
    detail.pricing.groupRatio,
    detail.breakdown.inputPerMillion,
    detail.breakdown.outputPerMillion,
    detail.breakdown.cacheReadPerMillion,
    detail.breakdown.cacheCreationPerMillion,
    detail.breakdown.inputCost,
    detail.breakdown.outputCost,
    detail.breakdown.cacheReadCost,
    detail.breakdown.cacheCreationCost,
    detail.breakdown.totalCost,
  ];

  return requiredNumbers.every(isFiniteNumber) ? detail : null;
}

export function getPricingDomainBillingDetails(
  log: ProxyLogListItem,
): PricingDomainBillingDetails | null {
  const detail = log.billingDetails;
  if (!detail || !('siteCostUsd' in detail) || !('actualCostCny' in detail)) return null;
  return isFiniteNumber(detail.siteCostUsd)
    && detail.siteCostUsd >= 0
    && isFiniteNumber(detail.actualCostCny)
    && detail.actualCostCny >= 0
    ? detail
    : null;
}

export function getProxyLogDisplayUsage(log: ProxyLogListItem): ProxyLogDisplayUsage {
  const pricingDetail = getPricingDomainBillingDetails(log);
  if (pricingDetail?.usage && isFiniteNumber(pricingDetail.usage.billablePromptTokens)) {
    return {
      inputTokens: pricingDetail.usage.billablePromptTokens,
      cacheReadTokens: pricingDetail.usage.cacheReadTokens,
      cacheCreationTokens: pricingDetail.usage.cacheWriteTokens,
    };
  }

  const legacyDetail = getCompleteBillingDetails(log);
  if (legacyDetail) {
    return {
      inputTokens: legacyDetail.usage.billablePromptTokens,
      cacheReadTokens: legacyDetail.usage.cacheReadTokens,
      cacheCreationTokens: legacyDetail.usage.cacheCreationTokens,
    };
  }

  if (!isFiniteNumber(log.promptTokens)) {
    return {
      inputTokens: null,
      cacheReadTokens: isFiniteNumber(log.cacheReadTokens) ? log.cacheReadTokens : null,
      cacheCreationTokens: isFiniteNumber(log.cacheCreationTokens) ? log.cacheCreationTokens : null,
    };
  }

  const cacheReadTokens = isFiniteNumber(log.cacheReadTokens)
    ? Math.max(0, log.cacheReadTokens)
    : 0;
  const cacheCreationTokens = isFiniteNumber(log.cacheCreationTokens)
    ? Math.max(0, log.cacheCreationTokens)
    : 0;

  return {
    inputTokens: log.promptTokensIncludeCache === true
      ? Math.max(0, log.promptTokens - cacheReadTokens - cacheCreationTokens)
      : log.promptTokens,
    cacheReadTokens: isFiniteNumber(log.cacheReadTokens) ? cacheReadTokens : null,
    cacheCreationTokens: isFiniteNumber(log.cacheCreationTokens) ? cacheCreationTokens : null,
  };
}
