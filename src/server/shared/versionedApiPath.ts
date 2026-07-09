const VERSIONED_API_PATH_SUFFIX = /\/v\d+(?:\.\d+)?(?:beta)?$/i;
const LEADING_VERSIONED_PATH_SEGMENT = /^\/v\d+(?:\.\d+)?(?:beta)?(?=\/|$)/i;

function stripTrailingSlashes(value: string): string {
  let normalized = value;
  while (normalized.length > 0 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function hasVersionedApiPathSuffix(pathOrUrl: string): boolean {
  return VERSIONED_API_PATH_SUFFIX.test(stripTrailingSlashes(pathOrUrl || ''));
}

function getVersionedApiPathSuffix(pathOrUrl: string): string | null {
  const match = stripTrailingSlashes(pathOrUrl || '').match(VERSIONED_API_PATH_SUFFIX);
  return match?.[0]?.slice(1).toLowerCase() || null;
}

export function stripLeadingVersionSegmentForVersionedBase(basePathOrUrl: string, requestPath: string): string {
  const baseVersion = getVersionedApiPathSuffix(basePathOrUrl);
  if (!baseVersion) return requestPath;

  const match = requestPath.match(LEADING_VERSIONED_PATH_SEGMENT);
  if (!match?.[0]) return requestPath;

  const requestVersion = match[0].slice(1).toLowerCase();
  if (requestVersion !== baseVersion && requestVersion !== 'v1') return requestPath;

  const stripped = requestPath.slice(match[0].length);
  return stripped.length > 0 ? stripped : '/';
}
