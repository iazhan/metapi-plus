import { describe, expect, it } from 'vitest';
import {
  buildTokenGroupOptions,
  formatTokenGroupLabel,
} from './tokenGroupPresentation.js';

describe('tokenGroupPresentation', () => {
  it('formats a token group with its account rate snapshot', () => {
    expect(formatTokenGroupLabel({
      tokenGroup: 'vip',
      groupRate: { groupKey: 'vip', groupName: 'VIP', ratio: 0.8 },
    })).toBe('VIP · 0.8x');
  });

  it('falls back to the stored group when rate metadata is invalid or absent', () => {
    expect(formatTokenGroupLabel({ tokenGroup: 'vip', groupRate: null })).toBe('vip');
    expect(formatTokenGroupLabel({
      tokenGroup: 'vip',
      groupRate: { groupKey: 'vip', groupName: 'VIP', ratio: Number.NaN },
    })).toBe('vip');
  });

  it('keeps raw group keys as option values while enriching labels', () => {
    expect(buildTokenGroupOptions(
      ['default', 'vip'],
      [{ groupKey: 'vip', groupName: 'VIP', ratio: 0.8 }],
    )).toEqual([
      { value: 'default', label: 'default' },
      { value: 'vip', label: 'VIP · 0.8x' },
    ]);
  });
});
