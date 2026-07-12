import type { MappingMode } from './contracts.js';

export interface CatalogModelIdentity {
  providerId: string;
  modelId: string;
}

export interface MappingRuleIdentity {
  mappingMode: MappingMode;
  mappedProviderId?: string | null;
  mappedModelId?: string | null;
}

export type ModelMappingResult =
  | {
      status: 'mapped';
      source: 'manual' | 'exact' | 'date_suffix';
      providerId: string;
      modelId: string;
    }
  | { status: 'custom' }
  | { status: 'unmapped' };

export interface MappingInput {
  upstreamModelId: string;
  providerHint?: string | null;
  catalog: CatalogModelIdentity[];
  rule?: MappingRuleIdentity | null;
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function findUniqueCandidate(
  catalog: CatalogModelIdentity[],
  upstreamModelId: string,
  providerHint?: string | null,
): CatalogModelIdentity | null {
  const normalizedUpstream = normalizeIdentity(upstreamModelId);
  const normalizedProviderHint = providerHint ? normalizeIdentity(providerHint) : null;
  const matches = catalog.filter((entry) => {
    if (normalizedProviderHint && normalizeIdentity(entry.providerId) !== normalizedProviderHint) {
      return false;
    }
    return normalizeIdentity(entry.modelId) === normalizedUpstream
      || normalizeIdentity(`${entry.providerId}/${entry.modelId}`) === normalizedUpstream;
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Resolves only explicit, exact, or controlled date-suffix mappings. */
export function resolveCatalogMapping(input: MappingInput): ModelMappingResult {
  if (input.rule?.mappingMode === 'manual') {
    if (input.rule.mappedProviderId && input.rule.mappedModelId) {
      return {
        status: 'mapped',
        source: 'manual',
        providerId: input.rule.mappedProviderId,
        modelId: input.rule.mappedModelId,
      };
    }
    return { status: 'unmapped' };
  }
  if (input.rule?.mappingMode === 'custom') {
    return { status: 'custom' };
  }

  const exact = findUniqueCandidate(input.catalog, input.upstreamModelId, input.providerHint);
  if (exact) {
    return {
      status: 'mapped',
      source: 'exact',
      providerId: exact.providerId,
      modelId: exact.modelId,
    };
  }

  const dateSuffixMatch = /^(.*)-\d{4}-\d{2}-\d{2}$/.exec(input.upstreamModelId.trim());
  if (!dateSuffixMatch?.[1]) return { status: 'unmapped' };
  const dated = findUniqueCandidate(input.catalog, dateSuffixMatch[1], input.providerHint);
  if (!dated) return { status: 'unmapped' };
  return {
    status: 'mapped',
    source: 'date_suffix',
    providerId: dated.providerId,
    modelId: dated.modelId,
  };
}
