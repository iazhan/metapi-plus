import { describe, expect, it, vi } from 'vitest';
import { createPriceRefreshScheduler } from './priceRefreshScheduler.js';

describe('price refresh scheduler', () => {
  it('uses the default cron/timezone and starts an asynchronous pass only for missing snapshots', async () => {
    const runPass = vi.fn().mockResolvedValue({});
    const schedule = vi.fn().mockReturnValue({ stop: vi.fn(), destroy: vi.fn() });
    const scheduler = createPriceRefreshScheduler({
      runPass,
      schedule,
      needsImmediateRefresh: vi.fn().mockResolvedValue(true),
      timeZone: () => 'Asia/Shanghai',
    });
    await scheduler.start({ enabled: true, cronExpr: '0 0 * * *' });
    expect(schedule).toHaveBeenCalledWith('0 0 * * *', expect.any(Function), { timezone: 'Asia/Shanghai' });
    await vi.waitFor(() => expect(runPass).toHaveBeenCalledTimes(1));
    await scheduler.stop();
  });

  it('does not overlap a manual trigger and cron tick', async () => {
    let release!: () => void;
    const runPass = vi.fn(() => new Promise((resolve) => { release = () => resolve({}); }));
    let tick!: () => void;
    const scheduler = createPriceRefreshScheduler({
      runPass,
      schedule: vi.fn((_expr, callback) => {
        tick = callback;
        return { stop: vi.fn(), destroy: vi.fn() };
      }),
      needsImmediateRefresh: vi.fn().mockResolvedValue(false),
      timeZone: () => 'Asia/Shanghai',
    });
    await scheduler.start({ enabled: true, cronExpr: '0 0 * * *' });
    const first = scheduler.trigger();
    tick();
    const second = scheduler.trigger();
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    release();
    await first;
    await scheduler.stop();
  });

  it('runs interval mode without registering a cron task', async () => {
    vi.useFakeTimers();
    try {
      const runPass = vi.fn().mockResolvedValue({});
      const schedule = vi.fn().mockReturnValue({ stop: vi.fn(), destroy: vi.fn() });
      const scheduler = createPriceRefreshScheduler({
        runPass,
        schedule,
        needsImmediateRefresh: vi.fn().mockResolvedValue(false),
        timeZone: () => 'Asia/Shanghai',
      });

      await scheduler.start({
        enabled: true,
        cronExpr: '0 0 * * *',
        scheduleMode: 'interval',
        intervalHours: 2,
      });
      expect(schedule).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(runPass).toHaveBeenCalledTimes(1);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and drains in-flight work before stop resolves', async () => {
    let observedSignal: AbortSignal | undefined;
    let release!: () => void;
    const runPass = vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise((resolve) => {
      observedSignal = signal;
      release = () => resolve({});
    }));
    const scheduler = createPriceRefreshScheduler({
      runPass,
      schedule: vi.fn().mockReturnValue({ stop: vi.fn(), destroy: vi.fn() }),
      needsImmediateRefresh: vi.fn().mockResolvedValue(false),
      timeZone: () => 'Asia/Shanghai',
    });
    await scheduler.start({ enabled: true, cronExpr: '0 0 * * *' });
    const pass = scheduler.trigger();
    const stop = scheduler.stop();
    expect(observedSignal?.aborted).toBe(true);
    let stopped = false;
    void stop.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([pass, stop]);
  });

  it('does not accept new work after lifecycle stop until restarted', async () => {
    const runPass = vi.fn().mockResolvedValue({});
    const scheduler = createPriceRefreshScheduler({
      runPass,
      schedule: vi.fn().mockReturnValue({ stop: vi.fn(), destroy: vi.fn() }),
      needsImmediateRefresh: vi.fn().mockResolvedValue(false),
      timeZone: () => 'Asia/Shanghai',
    });
    await scheduler.start({ enabled: true, cronExpr: '0 0 * * *' });
    await scheduler.stop();

    await expect(scheduler.trigger()).rejects.toThrow('stopped');
    expect(runPass).not.toHaveBeenCalled();
  });
});
