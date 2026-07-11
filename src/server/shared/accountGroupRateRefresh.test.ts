import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_GROUP_RATE_REFRESH_DEFAULT_ENABLED,
  ACCOUNT_GROUP_RATE_REFRESH_DEFAULT_INTERVAL_MINUTES,
  ACCOUNT_GROUP_RATE_REFRESH_MAX_INTERVAL_MINUTES,
  ACCOUNT_GROUP_RATE_REFRESH_MIN_INTERVAL_MINUTES,
  normalizeAccountGroupRateRefreshIntervalMinutes,
} from './accountGroupRateRefresh.js';

describe('account group rate refresh settings', () => {
  it('publishes the approved defaults and bounds', () => {
    expect(ACCOUNT_GROUP_RATE_REFRESH_DEFAULT_ENABLED).toBe(true);
    expect(ACCOUNT_GROUP_RATE_REFRESH_DEFAULT_INTERVAL_MINUTES).toBe(30);
    expect(ACCOUNT_GROUP_RATE_REFRESH_MIN_INTERVAL_MINUTES).toBe(5);
    expect(ACCOUNT_GROUP_RATE_REFRESH_MAX_INTERVAL_MINUTES).toBe(10080);
  });

  it('accepts only integer minute values inside the approved range', () => {
    expect(normalizeAccountGroupRateRefreshIntervalMinutes(5)).toBe(5);
    expect(normalizeAccountGroupRateRefreshIntervalMinutes('30')).toBe(30);
    expect(normalizeAccountGroupRateRefreshIntervalMinutes(10080)).toBe(10080);
    expect(normalizeAccountGroupRateRefreshIntervalMinutes(4)).toBeNull();
    expect(normalizeAccountGroupRateRefreshIntervalMinutes(10081)).toBeNull();
    expect(normalizeAccountGroupRateRefreshIntervalMinutes(30.5)).toBeNull();
    expect(normalizeAccountGroupRateRefreshIntervalMinutes('invalid')).toBeNull();
  });
});
