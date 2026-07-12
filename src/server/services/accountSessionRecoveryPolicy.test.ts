import { describe, expect, it } from 'vitest';
import { shouldAttemptAccountSessionRecovery } from './accountSessionRecoveryPolicy.js';

describe('account session recovery policy', () => {
  it('uses strict recovery for check-in style failures', () => {
    expect(shouldAttemptAccountSessionRecovery('access token invalid', 'strict')).toBe(true);
    expect(shouldAttemptAccountSessionRecovery('new-api-user missing', 'strict')).toBe(true);
    expect(shouldAttemptAccountSessionRecovery('forbidden by plan', 'strict')).toBe(false);
  });

  it('uses broad recovery for balance and rate endpoints', () => {
    expect(shouldAttemptAccountSessionRecovery('unauthorized', 'broad')).toBe(true);
    expect(shouldAttemptAccountSessionRecovery('not logged in', 'broad')).toBe(true);
    expect(shouldAttemptAccountSessionRecovery('HTTP 403: forbidden by role', 'broad')).toBe(false);
    expect(shouldAttemptAccountSessionRecovery('HTTP 403: 无权访问该分组', 'broad')).toBe(false);
    expect(shouldAttemptAccountSessionRecovery('HTTP 403: 权限不足', 'broad')).toBe(false);
    expect(shouldAttemptAccountSessionRecovery('HTTP 403: access token lacks permission', 'broad')).toBe(false);
    expect(shouldAttemptAccountSessionRecovery('HTTP 403: New-Api-User permission denied', 'broad')).toBe(false);
    expect(shouldAttemptAccountSessionRecovery('HTTP 403: access token expired', 'broad')).toBe(true);
    expect(shouldAttemptAccountSessionRecovery('invalid session token', 'broad')).toBe(true);
    expect(shouldAttemptAccountSessionRecovery('subscription expired', 'broad')).toBe(false);
    expect(shouldAttemptAccountSessionRecovery('upstream timeout', 'broad')).toBe(false);
  });
});
