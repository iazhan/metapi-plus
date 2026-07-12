import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cronStopMock = vi.fn();
const scheduleMock = vi.fn(() => ({
  stop: cronStopMock,
}));
const validateMock = vi.fn(() => true);
const allMock = vi.fn();

vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => scheduleMock(...args),
    validate: (...args: unknown[]) => validateMock(...args),
  },
}));

vi.mock('../db/index.js', () => {
  const queryChain = {
    where: () => queryChain,
    get: () => undefined,
    all: () => [],
    from: () => queryChain,
    innerJoin: () => queryChain,
  };

  return {
    db: {
      select: () => queryChain,
    },
    schema: {
      settings: { key: 'key' },
      accounts: { checkinEnabled: 'checkinEnabled', status: 'status' },
      sites: { id: 'id' },
    },
  };
});

vi.mock('./checkinService.js', () => ({
  checkinAll: (...args: unknown[]) => allMock(...args),
}));

describe('checkinScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cronStopMock.mockReset();
    scheduleMock.mockClear();
    validateMock.mockClear();
    allMock.mockReset();
  });

  afterEach(async () => {
    const scheduler = await import('./checkinScheduler.js');
    await scheduler.__resetCheckinSchedulerForTests();
    vi.useRealTimers();
  });

  it('switches from cron mode to interval mode and back', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '0 8 * * *',
      intervalHours: 6,
    });
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'interval',
      intervalHours: 6,
    });
    expect(cronStopMock).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '5 9 * * *',
      intervalHours: 6,
    });
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
  });

  it('selects due accounts from the last successful checkin time', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date('2026-03-20T12:00:00.000Z');

    expect(scheduler.selectDueIntervalCheckinAccountIds([
      { id: 1, lastCheckinAt: null },
      { id: 2, lastCheckinAt: '2026-03-20T05:59:59.000Z' },
      { id: 3, lastCheckinAt: '2026-03-20T06:30:00.000Z' },
    ], 6, now)).toEqual([1, 2]);
  });

  it('stops every owned schedule during server shutdown', async () => {
    const scheduler = await import('./checkinScheduler.js');
    await scheduler.startScheduler();
    expect(scheduleMock).toHaveBeenCalledTimes(4);

    await scheduler.stopScheduler();

    expect(cronStopMock).toHaveBeenCalledTimes(4);
  });

  it('waits for an in-flight scheduled check-in before shutdown completes', async () => {
    let release!: (value: unknown[]) => void;
    allMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const scheduler = await import('./checkinScheduler.js');
    await scheduler.startScheduler();
    const checkinCallback = scheduleMock.mock.calls[0]?.[1] as (() => void) | undefined;
    expect(checkinCallback).toBeTypeOf('function');
    checkinCallback?.();

    let stopped = false;
    const stopping = scheduler.stopScheduler().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release([]);
    await stopping;
    expect(stopped).toBe(true);
  });
});
