export const EXPLICIT_USAGE_LIMIT_RATE_LIMIT_PATTERNS: RegExp[] = [
  /usage_limit_reached/i,
  /usage\s+limit\s+has\s+been\s+reached/i,
  /quota\s+exceeded/i,
  /insufficient[_\s-]+quota/i,
];

export const USAGE_LIMIT_RATE_LIMIT_PATTERNS: RegExp[] = [
  ...EXPLICIT_USAGE_LIMIT_RATE_LIMIT_PATTERNS,
  /rate\s+limit/i,
  /\blimit\b/i,
];

function matchesAnyPattern(patterns: RegExp[], input?: string | null): boolean {
  const text = (input || '').trim();
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

export function matchesExplicitUsageLimitFailureText(input?: string | null): boolean {
  return matchesAnyPattern(EXPLICIT_USAGE_LIMIT_RATE_LIMIT_PATTERNS, input);
}

export function matchesUsageLimitFailureText(input?: string | null): boolean {
  return matchesAnyPattern(USAGE_LIMIT_RATE_LIMIT_PATTERNS, input);
}

export function isUsageLimitRateLimitFailure(input: {
  status?: number | null;
  message?: string | null;
}): boolean {
  return input.status === 429 && matchesUsageLimitFailureText(input.message);
}

export function isExplicitUsageLimitRateLimitFailure(input: {
  status?: number | null;
  message?: string | null;
}): boolean {
  return input.status === 429 && matchesExplicitUsageLimitFailureText(input.message);
}
