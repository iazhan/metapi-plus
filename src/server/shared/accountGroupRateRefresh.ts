export const ACCOUNT_GROUP_RATE_REFRESH_DEFAULT_ENABLED = true;
export const ACCOUNT_GROUP_RATE_REFRESH_DEFAULT_INTERVAL_MINUTES = 30;
export const ACCOUNT_GROUP_RATE_REFRESH_MIN_INTERVAL_MINUTES = 5;
export const ACCOUNT_GROUP_RATE_REFRESH_MAX_INTERVAL_MINUTES = 10_080;

export function normalizeAccountGroupRateRefreshIntervalMinutes(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim()
    ? Number(value)
    : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return null;
  }
  if (
    parsed < ACCOUNT_GROUP_RATE_REFRESH_MIN_INTERVAL_MINUTES
    || parsed > ACCOUNT_GROUP_RATE_REFRESH_MAX_INTERVAL_MINUTES
  ) {
    return null;
  }
  return parsed;
}
