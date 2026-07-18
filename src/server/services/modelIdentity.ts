/** Returns the case-insensitive identity used by model aliases and projections. */
export function normalizeModelIdentityKey(value: string): string {
  return value.trim().toLowerCase();
}
