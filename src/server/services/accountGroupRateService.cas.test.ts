import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  transaction: vi.fn(),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: (...conditions: unknown[]) => conditions,
    asc: (column: unknown) => column,
    eq: (column: unknown, value: unknown) => ({ column, value }),
    isNull: (column: unknown) => ({ column, isNull: true }),
    or: (...conditions: unknown[]) => conditions,
  };
});

vi.mock('../db/index.js', () => ({
  db: dbMock,
  schema: {
    accounts: {
      id: 'accounts.id',
      status: 'accounts.status',
      accessToken: 'accounts.accessToken',
      extraConfig: 'accounts.extraConfig',
    },
    accountGroupRates: {
      accountId: 'accountGroupRates.accountId',
      groupKey: 'accountGroupRates.groupKey',
    },
  },
}));

describe('accountGroupRateService active-session CAS', () => {
  beforeEach(() => {
    dbMock.transaction.mockReset();
  });

  it('claims an active session before deleting its previous snapshot', async () => {
    const operations: string[] = [];
    const fakeTx = {
      select: () => ({
        from: () => ({
          where: () => ({
            get: async () => {
              operations.push('select');
              return {
                id: 101,
                status: 'active',
                accessToken: 'session-token',
                extraConfig: null,
              };
            },
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            run: async () => {
              operations.push('cas');
              return { changes: 0 };
            },
          }),
        }),
      }),
      delete: () => ({
        where: () => ({
          run: async () => {
            operations.push('delete');
          },
        }),
      }),
      insert: () => ({
        values: () => ({
          run: async () => {
            operations.push('insert');
          },
        }),
      }),
    };
    dbMock.transaction.mockImplementationOnce(async (callback: any) => callback(fakeTx));
    const service = await import('./accountGroupRateService.js');

    await expect(service.replaceAccountGroupRatesForSession(
      101,
      'session-token',
      null,
      [{ groupKey: 'vip', groupName: 'VIP', ratio: 0.8 }],
      '2026-07-11T01:00:00.000Z',
    )).resolves.toEqual({ status: 'stale' });
    expect(operations).toEqual(['select', 'cas']);
  });
});
