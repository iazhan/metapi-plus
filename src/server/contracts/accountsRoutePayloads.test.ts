import { describe, expect, it } from 'vitest';
import {
  parseAccountCreatePayload,
  parseAccountUpdatePayload,
} from './accountsRoutePayloads.js';

describe('accounts route payloads', () => {
  it('strips the removed unitCost field from account writes', () => {
    const created = parseAccountCreatePayload({
      siteId: 1,
      username: 'alice',
      unitCost: 12.5,
    });
    const updated = parseAccountUpdatePayload({
      username: 'bob',
      unitCost: null,
    });

    expect(created).toEqual({
      success: true,
      data: { siteId: 1, username: 'alice' },
    });
    expect(updated).toEqual({
      success: true,
      data: { username: 'bob' },
    });
  });
});
