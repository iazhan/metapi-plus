import {
  db,
  schema,
  hasProxyLogBillingDetailsColumn,
  hasProxyLogClientColumns,
  hasProxyLogCompatibilityNotesColumn,
  hasProxyLogDownstreamApiKeyIdColumn,
  hasProxyLogStreamTimingColumns,
} from '../db/index.js';

export type ProxyLogCompatibilityNotes = {
  responsesStripImageGeneration?: {
    enabled: boolean;
    removed: number;
  };
};

export type ProxyLogInsertInput = {
  routeId?: number | null;
  channelId?: number | null;
  accountId?: number | null;
  downstreamApiKeyId?: number | null;
  modelRequested?: string | null;
  modelActual?: string | null;
  status?: string | null;
  httpStatus?: number | null;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  promptTokensIncludeCache?: boolean | null;
  totalTokens?: number | null;
  estimatedCost?: number | null;
  billingDetails?: unknown;
  compatibilityNotes?: ProxyLogCompatibilityNotes | null;
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: string | null;
  errorMessage?: string | null;
  retryCount?: number | null;
  createdAt?: string | null;
};

function buildProxyLogCoreSelectFields() {
  return {
    id: schema.proxyLogs.id,
    routeId: schema.proxyLogs.routeId,
    channelId: schema.proxyLogs.channelId,
    accountId: schema.proxyLogs.accountId,
    downstreamApiKeyId: schema.proxyLogs.downstreamApiKeyId,
    modelRequested: schema.proxyLogs.modelRequested,
    modelActual: schema.proxyLogs.modelActual,
    status: schema.proxyLogs.status,
    httpStatus: schema.proxyLogs.httpStatus,
    latencyMs: schema.proxyLogs.latencyMs,
    promptTokens: schema.proxyLogs.promptTokens,
    completionTokens: schema.proxyLogs.completionTokens,
    cacheReadTokens: schema.proxyLogs.cacheReadTokens,
    cacheCreationTokens: schema.proxyLogs.cacheCreationTokens,
    promptTokensIncludeCache: schema.proxyLogs.promptTokensIncludeCache,
    totalTokens: schema.proxyLogs.totalTokens,
    estimatedCost: schema.proxyLogs.estimatedCost,
    errorMessage: schema.proxyLogs.errorMessage,
    retryCount: schema.proxyLogs.retryCount,
    createdAt: schema.proxyLogs.createdAt,
  };
}

function buildProxyLogClientSelectFields() {
  return {
    clientFamily: schema.proxyLogs.clientFamily,
    clientAppId: schema.proxyLogs.clientAppId,
    clientAppName: schema.proxyLogs.clientAppName,
    clientConfidence: schema.proxyLogs.clientConfidence,
  };
}

function buildProxyLogStreamTimingSelectFields() {
  return {
    isStream: schema.proxyLogs.isStream,
    firstByteLatencyMs: schema.proxyLogs.firstByteLatencyMs,
  };
}

function buildProxyLogCompatibilityNotesSelectFields() {
  return {
    compatibilityNotes: schema.proxyLogs.compatibilityNotes,
  };
}

function buildProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeClientFields?: boolean;
  includeCompatibilityNotes?: boolean;
  includeStreamTimingFields?: boolean;
}) {
  return {
    ...buildProxyLogCoreSelectFields(),
    ...(options?.includeStreamTimingFields ? buildProxyLogStreamTimingSelectFields() : {}),
    ...(options?.includeClientFields ? buildProxyLogClientSelectFields() : {}),
    ...(options?.includeCompatibilityNotes ? buildProxyLogCompatibilityNotesSelectFields() : {}),
    ...(options?.includeBillingDetails ? { billingDetails: schema.proxyLogs.billingDetails } : {}),
  };
}

export function getProxyLogBaseSelectFields() {
  return buildProxyLogCoreSelectFields();
}

export type ProxyLogSelectFields = ReturnType<typeof buildProxyLogSelectFields>;

export type ResolvedProxyLogSelectFields = {
  includeBillingDetails: boolean;
  includeClientFields: boolean;
  includeCompatibilityNotes: boolean;
  includeStreamTimingFields: boolean;
  fields: ProxyLogSelectFields;
};

export async function resolveProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeClientFields?: boolean;
  includeCompatibilityNotes?: boolean;
  includeStreamTimingFields?: boolean;
}) {
  const includeBillingDetails = options?.includeBillingDetails === true
    && await hasProxyLogBillingDetailsColumn();
  const includeClientFields = options?.includeClientFields !== false
    && await hasProxyLogClientColumns();
  const includeCompatibilityNotes = options?.includeCompatibilityNotes !== false
    && await hasProxyLogCompatibilityNotesColumn();
  const includeStreamTimingFields = options?.includeStreamTimingFields !== false
    && await hasProxyLogStreamTimingColumns();

  return {
    includeBillingDetails,
    includeClientFields,
    includeCompatibilityNotes,
    includeStreamTimingFields,
    fields: buildProxyLogSelectFields({
      includeBillingDetails,
      includeClientFields,
      includeCompatibilityNotes,
      includeStreamTimingFields,
    }),
  };
}

export async function withProxyLogSelectFields<T>(
  runner: (selection: ResolvedProxyLogSelectFields) => Promise<T>,
  options?: {
    includeBillingDetails?: boolean;
    includeClientFields?: boolean;
    includeCompatibilityNotes?: boolean;
    includeStreamTimingFields?: boolean;
  },
): Promise<T> {
  let selection = await resolveProxyLogSelectFields(options);

  while (true) {
    try {
      return await runner(selection);
    } catch (error) {
      if (selection.includeBillingDetails && isMissingBillingDetailsColumnError(error)) {
        selection = {
          includeBillingDetails: false,
          includeClientFields: selection.includeClientFields,
          includeCompatibilityNotes: selection.includeCompatibilityNotes,
          includeStreamTimingFields: selection.includeStreamTimingFields,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: false,
            includeClientFields: selection.includeClientFields,
            includeCompatibilityNotes: selection.includeCompatibilityNotes,
            includeStreamTimingFields: selection.includeStreamTimingFields,
          }),
        };
        continue;
      }

      if (selection.includeClientFields && isMissingProxyLogClientColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeClientFields: false,
          includeCompatibilityNotes: selection.includeCompatibilityNotes,
          includeStreamTimingFields: selection.includeStreamTimingFields,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeClientFields: false,
            includeCompatibilityNotes: selection.includeCompatibilityNotes,
            includeStreamTimingFields: selection.includeStreamTimingFields,
          }),
        };
        continue;
      }

      if (selection.includeCompatibilityNotes && isMissingProxyLogCompatibilityNotesColumnError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeClientFields: selection.includeClientFields,
          includeCompatibilityNotes: false,
          includeStreamTimingFields: selection.includeStreamTimingFields,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeClientFields: selection.includeClientFields,
            includeCompatibilityNotes: false,
            includeStreamTimingFields: selection.includeStreamTimingFields,
          }),
        };
        continue;
      }

      if (selection.includeStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeClientFields: selection.includeClientFields,
          includeCompatibilityNotes: selection.includeCompatibilityNotes,
          includeStreamTimingFields: false,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeClientFields: selection.includeClientFields,
            includeCompatibilityNotes: selection.includeCompatibilityNotes,
            includeStreamTimingFields: false,
          }),
        };
        continue;
      }

      throw error;
    }
  }
}

export function parseProxyLogBillingDetails(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseProxyLogCostSnapshot(value: unknown): {
  siteCostUsd: number;
  actualCostCny: number;
} | null {
  const details = parseProxyLogBillingDetails(value);
  if (!details) return null;
  const siteCostUsd = details.siteCostUsd;
  const actualCostCny = details.actualCostCny;
  if (
    typeof siteCostUsd !== 'number'
    || !Number.isFinite(siteCostUsd)
    || siteCostUsd < 0
    || typeof actualCostCny !== 'number'
    || !Number.isFinite(actualCostCny)
    || actualCostCny < 0
  ) {
    return null;
  }
  return { siteCostUsd, actualCostCny };
}

export function parseProxyLogCompatibilityNotes(value: unknown): ProxyLogCompatibilityNotes | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ProxyLogCompatibilityNotes;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ProxyLogCompatibilityNotes
      : null;
  } catch {
    return null;
  }
}

function normalizeProxyLogStoreErrorMessage(error: unknown): string {
  const message = typeof error === 'object' && error && 'message' in error
    ? String((error as { message?: unknown }).message || '')
    : String(error || '');
  return message.toLowerCase();
}

export function isMissingBillingDetailsColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('billing_details')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingDownstreamApiKeyIdColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('downstream_api_key_id')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogClientColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasClientColumnReference = [
    'client_family',
    'client_app_id',
    'client_app_name',
    'client_confidence',
  ].some((columnName) => lowered.includes(columnName));

  return hasClientColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogCompatibilityNotesColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('compatibility_notes')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogStreamTimingColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasStreamTimingColumnReference = [
    'is_stream',
    'first_byte_latency_ms',
  ].some((columnName) => lowered.includes(columnName));

  return hasStreamTimingColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export async function insertProxyLog(input: ProxyLogInsertInput): Promise<void> {
  const baseValues = {
    routeId: input.routeId ?? null,
    channelId: input.channelId ?? null,
    accountId: input.accountId ?? null,
    modelRequested: input.modelRequested ?? null,
    modelActual: input.modelActual ?? null,
    status: input.status ?? null,
    httpStatus: input.httpStatus ?? null,
    latencyMs: input.latencyMs ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    ...(input.cacheReadTokens != null ? { cacheReadTokens: input.cacheReadTokens } : {}),
    ...(input.cacheCreationTokens != null ? { cacheCreationTokens: input.cacheCreationTokens } : {}),
    ...(input.promptTokensIncludeCache != null ? { promptTokensIncludeCache: input.promptTokensIncludeCache } : {}),
    totalTokens: input.totalTokens ?? null,
    estimatedCost: input.estimatedCost ?? 0,
    errorMessage: input.errorMessage ?? null,
    retryCount: input.retryCount ?? 0,
    createdAt: input.createdAt ?? null,
  };
  const serializedBillingDetails = input.billingDetails == null
    ? null
    : JSON.stringify(input.billingDetails);
  const serializedCompatibilityNotes = input.compatibilityNotes == null
    ? null
    : JSON.stringify(input.compatibilityNotes);
  const includeBillingDetails = serializedBillingDetails !== null
    && await hasProxyLogBillingDetailsColumn();
  const includeCompatibilityNotes = serializedCompatibilityNotes !== null
    && await hasProxyLogCompatibilityNotesColumn();
  const includeDownstreamApiKeyId = input.downstreamApiKeyId != null
    && await hasProxyLogDownstreamApiKeyIdColumn();
  const requestedClientFields = [
    input.clientFamily,
    input.clientAppId,
    input.clientAppName,
    input.clientConfidence,
  ].some((value) => value != null && String(value).trim().length > 0);
  const includeClientFields = requestedClientFields
    && await hasProxyLogClientColumns();
  const requestedStreamTimingFields = input.isStream != null || input.firstByteLatencyMs != null;
  const includeStreamTimingFields = requestedStreamTimingFields
    && await hasProxyLogStreamTimingColumns();

  let allowBillingDetails = includeBillingDetails;
  let allowCompatibilityNotes = includeCompatibilityNotes;
  let allowDownstreamApiKeyId = includeDownstreamApiKeyId;
  let allowClientFields = includeClientFields;
  let allowStreamTimingFields = includeStreamTimingFields;

  while (true) {
    const values = {
      ...baseValues,
      ...(allowStreamTimingFields
        ? {
          isStream: input.isStream ?? null,
          firstByteLatencyMs: input.firstByteLatencyMs ?? null,
        }
        : {}),
      ...(allowBillingDetails ? { billingDetails: serializedBillingDetails } : {}),
      ...(allowCompatibilityNotes ? { compatibilityNotes: serializedCompatibilityNotes } : {}),
      ...(allowDownstreamApiKeyId ? { downstreamApiKeyId: input.downstreamApiKeyId } : {}),
      ...(allowClientFields
        ? {
          clientFamily: input.clientFamily ?? null,
          clientAppId: input.clientAppId ?? null,
          clientAppName: input.clientAppName ?? null,
          clientConfidence: input.clientConfidence ?? null,
        }
        : {}),
    };

    try {
      await db.insert(schema.proxyLogs).values(values).run();
      return;
    } catch (error) {
      if (allowBillingDetails && isMissingBillingDetailsColumnError(error)) {
        allowBillingDetails = false;
        continue;
      }

      if (allowDownstreamApiKeyId && isMissingDownstreamApiKeyIdColumnError(error)) {
        allowDownstreamApiKeyId = false;
        continue;
      }

      if (allowCompatibilityNotes && isMissingProxyLogCompatibilityNotesColumnError(error)) {
        allowCompatibilityNotes = false;
        continue;
      }

      if (allowClientFields && isMissingProxyLogClientColumnsError(error)) {
        allowClientFields = false;
        continue;
      }

      if (allowStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        allowStreamTimingFields = false;
        continue;
      }

      throw error;
    }
  }
}
