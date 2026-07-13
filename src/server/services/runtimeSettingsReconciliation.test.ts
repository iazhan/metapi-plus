import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';

const calls = vi.hoisted(() => ({
  hydrate: vi.fn(), updateCheckin: vi.fn(), updateBalance: vi.fn(),
  updateLogCleanup: vi.fn(), startModel: vi.fn(), stopModel: vi.fn(),
  startLegacy: vi.fn(), stopLegacy: vi.fn(), invalidate: vi.fn(),
  updatePriceRefresh: vi.fn(), invalidatePricing: vi.fn(),
}));

describe('runtimeSettingsReconciliation', () => {
  beforeEach(() => { Object.values(calls).forEach((mock) => mock.mockReset()); });

  it.each([
    { cleanupConfigured: true, probeEnabled: true, logAction: 'stopLegacy', modelAction: 'startModel' },
    { cleanupConfigured: false, probeEnabled: false, logAction: 'startLegacy', modelAction: 'stopModel' },
  ])('reconciles all setting-owned services from one hydrated snapshot', async (input) => {
    calls.hydrate.mockImplementation(async () => {
      config.checkinScheduleMode = 'interval'; config.checkinCron = '0 3 * * *';
      config.checkinIntervalHours = 6; config.balanceRefreshCron = '0 */2 * * *';
      config.logCleanupCron = '0 4 * * *'; config.logCleanupUsageLogsEnabled = true;
      config.logCleanupProgramLogsEnabled = false; config.logCleanupRetentionDays = 14;
      config.logCleanupConfigured = input.cleanupConfigured;
      config.modelAvailabilityProbeEnabled = input.probeEnabled;
      config.priceRefreshEnabled = false;
      config.priceRefreshCron = '0 6 * * *';
      config.priceRefreshScheduleMode = 'cron';
      config.priceRefreshIntervalHours = 6;
      return new Map();
    });
    const { reconcileRuntimeSettingsFromPersistedSnapshot } = await import('./runtimeSettingsReconciliation.js');
    await reconcileRuntimeSettingsFromPersistedSnapshot({
      hydrate: calls.hydrate, updateCheckin: calls.updateCheckin,
      updateBalance: calls.updateBalance, updateLogCleanup: calls.updateLogCleanup,
      startModelProbe: calls.startModel, stopModelProbe: calls.stopModel,
      startLegacyLogRetention: calls.startLegacy, stopLegacyLogRetention: calls.stopLegacy,
      invalidateProxyCache: calls.invalidate,
      updatePriceRefresh: calls.updatePriceRefresh,
      invalidatePricingCache: calls.invalidatePricing,
    });
    expect(calls.hydrate).toHaveBeenCalledTimes(1);
    expect(calls.updateCheckin).toHaveBeenCalledWith({ mode: 'interval', cronExpr: '0 3 * * *', intervalHours: 6 });
    expect(calls.updateBalance).toHaveBeenCalledWith('0 */2 * * *');
    expect(calls.updateLogCleanup).toHaveBeenCalledWith({ cronExpr: '0 4 * * *', usageLogsEnabled: true, programLogsEnabled: false, retentionDays: 14 });
    expect(calls[input.logAction as keyof typeof calls]).toHaveBeenCalledTimes(1);
    expect(calls[input.modelAction as keyof typeof calls]).toHaveBeenCalledTimes(1);
    expect(calls.invalidate).toHaveBeenCalledTimes(1);
    expect(calls.updatePriceRefresh).toHaveBeenCalledWith({
      enabled: false,
      cronExpr: '0 6 * * *',
      scheduleMode: 'cron',
      intervalHours: 6,
    });
    expect(calls.invalidatePricing).toHaveBeenCalledTimes(1);
  });
});
