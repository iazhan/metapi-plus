const CLAUDE_DEFAULT_USER_AGENT = 'claude-cli/2.1.63 (external, cli)';
export const CLAUDE_TOKEN_COUNTING_BETA = 'token-counting-2024-11-01';
export const CLAUDE_API_KEY_DEFAULT_BETA_HEADER = 'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05';

export function headerValueToString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

export function getInputHeader(
  headers: Record<string, unknown> | Record<string, string> | undefined,
  key: string,
): string | null {
  if (!headers) return null;
  for (const [candidateKey, candidateValue] of Object.entries(headers)) {
    if (candidateKey.toLowerCase() !== key.toLowerCase()) continue;
    return headerValueToString(candidateValue);
  }
  return null;
}

function normalizeLowerCaseHeaderMap(
  sources: Array<Record<string, unknown> | Record<string, string> | undefined>,
  shouldSkip: (key: string) => boolean,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      const normalizedValue = headerValueToString(value);
      if (!normalizedValue) continue;
      const normalizedKey = key.toLowerCase();
      if (shouldSkip(normalizedKey)) continue;
      normalized[normalizedKey] = normalizedValue;
    }
  }
  return normalized;
}

export function mergeClaudeBetaHeader(
  explicitValue: string | null,
  defaultValue: string,
  extraBetas: string[] = [],
): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const source of [defaultValue, explicitValue ?? '', ...extraBetas]) {
    for (const entry of source.split(',')) {
      const normalized = entry.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(normalized);
    }
  }
  return merged.join(',');
}

export function buildClaudeRuntimeHeaders(input: {
  baseHeaders: Record<string, string>;
  claudeHeaders: Record<string, string>;
  anthropicVersion: string;
  stream: boolean;
  tokenValue: string;
  extraBetas?: string[];
  defaultBetaHeader?: string;
  defaultUserAgent?: string;
}): Record<string, string> {
  const anthropicBeta = mergeClaudeBetaHeader(
    getInputHeader(input.claudeHeaders, 'anthropic-beta'),
    input.defaultBetaHeader || CLAUDE_API_KEY_DEFAULT_BETA_HEADER,
    input.extraBetas,
  );
  const passthroughHeaders = normalizeLowerCaseHeaderMap(
    [input.baseHeaders, input.claudeHeaders],
    (key) => (
      key === 'accept'
      || key === 'accept-encoding'
      || key === 'anthropic-beta'
      || key === 'anthropic-dangerous-direct-browser-access'
      || key === 'anthropic-version'
      || key === 'authorization'
      || key === 'connection'
      || key === 'user-agent'
      || key === 'x-api-key'
      || key === 'x-app'
      || key.startsWith('x-stainless-')
    ),
  );
  const headers: Record<string, string> = {
    ...passthroughHeaders,
    'anthropic-version': input.anthropicVersion,
    ...(anthropicBeta ? { 'anthropic-beta': anthropicBeta } : {}),
    'Anthropic-Dangerous-Direct-Browser-Access': 'true',
    'X-App': 'cli',
    'X-Stainless-Retry-Count': getInputHeader(input.claudeHeaders, 'x-stainless-retry-count') || '0',
    'X-Stainless-Runtime-Version': getInputHeader(input.claudeHeaders, 'x-stainless-runtime-version') || 'v24.3.0',
    'X-Stainless-Package-Version': getInputHeader(input.claudeHeaders, 'x-stainless-package-version') || '0.74.0',
    'X-Stainless-Runtime': getInputHeader(input.claudeHeaders, 'x-stainless-runtime') || 'node',
    'X-Stainless-Lang': getInputHeader(input.claudeHeaders, 'x-stainless-lang') || 'js',
    'X-Stainless-Arch': getInputHeader(input.claudeHeaders, 'x-stainless-arch') || 'x64',
    'X-Stainless-Os': getInputHeader(input.claudeHeaders, 'x-stainless-os') || 'Windows',
    'X-Stainless-Timeout': getInputHeader(input.claudeHeaders, 'x-stainless-timeout') || '600',
    'User-Agent': getInputHeader(input.claudeHeaders, 'user-agent') || input.defaultUserAgent || CLAUDE_DEFAULT_USER_AGENT,
    Connection: 'keep-alive',
    Accept: input.stream ? 'text/event-stream' : 'application/json',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
  };
  headers['x-api-key'] = input.tokenValue;
  return headers;
}
