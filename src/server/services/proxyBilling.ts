import {
  buildBillingSnapshot,
  type BillingSnapshotInput,
} from '../pricing/billingSnapshotService.js';
import type { PricingBillingSnapshot } from '../pricing/contracts.js';
import { getCredentialModeFromExtraConfig } from './accountExtraConfig.js';
import type { SelfLogBillingMeta } from './proxyUsageFallbackService.js';

interface ProxyBillingUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  promptTokensIncludeCache: boolean | null;
}

interface ResolvedProxyUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  recoveredFromSelfLog: boolean;
  estimatedCostFromQuota: number;
  selfLogBillingMeta: SelfLogBillingMeta | null;
}

interface ResolveProxyLogBillingInput {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
    extraConfig?: string | null;
  };
  tokenGroup?: string | null;
  modelName: string;
  parsedUsage: ProxyBillingUsageSummary;
  resolvedUsage: ResolvedProxyUsageSummary;
}

type PerCallProxyBillingInput = Pick<ResolveProxyLogBillingInput, 'site' | 'account' | 'tokenGroup' | 'modelName'>;

export type ProxyBillingDetails = PricingBillingSnapshot;

function buildSnapshotInput(input: ResolveProxyLogBillingInput): BillingSnapshotInput {
  const selfLogMeta = input.resolvedUsage.selfLogBillingMeta;
  const credentialKind = getCredentialModeFromExtraConfig(input.account.extraConfig) === 'apikey'
    ? 'api_key' as const
    : 'session' as const;
  return {
    siteId: input.site.id,
    accountId: input.account.id,
    tokenGroup: credentialKind === 'api_key' ? 'default' : (input.tokenGroup ?? null),
    credentialKind,
    upstreamModelId: input.modelName,
    promptTokens: input.resolvedUsage.promptTokens,
    completionTokens: input.resolvedUsage.completionTokens,
    cacheReadTokens: selfLogMeta?.cacheReadTokens ?? input.parsedUsage.cacheReadTokens,
    cacheWriteTokens: selfLogMeta?.cacheCreationTokens ?? input.parsedUsage.cacheCreationTokens,
    promptTokensIncludeCache: selfLogMeta?.promptTokensIncludeCache
      ?? input.parsedUsage.promptTokensIncludeCache,
  };
}

function buildPerCallSnapshotInput(input: PerCallProxyBillingInput): BillingSnapshotInput {
  const credentialKind = getCredentialModeFromExtraConfig(input.account.extraConfig) === 'apikey'
    ? 'api_key' as const
    : 'session' as const;
  return {
    siteId: input.site.id,
    accountId: input.account.id,
    tokenGroup: credentialKind === 'api_key' ? 'default' : (input.tokenGroup ?? null),
    credentialKind,
    upstreamModelId: input.modelName,
    promptTokens: 0,
    completionTokens: 0,
  };
}

function toResolvedBilling(billingDetails: PricingBillingSnapshot | null) {
  return {
    estimatedCost: billingDetails?.siteCostUsd ?? 0,
    actualCostCny: billingDetails?.actualCostCny ?? 0,
    billingDetails,
  };
}

export async function resolveProxyLogBilling(
  input: ResolveProxyLogBillingInput,
): Promise<{
  estimatedCost: number;
  actualCostCny: number;
  billingDetails: ProxyBillingDetails | null;
}> {
  const billingDetails = await buildBillingSnapshot(buildSnapshotInput(input));
  return toResolvedBilling(billingDetails);
}

export async function resolvePerCallProxyBilling(input: PerCallProxyBillingInput) {
  return toResolvedBilling(await buildBillingSnapshot(buildPerCallSnapshotInput(input)));
}
