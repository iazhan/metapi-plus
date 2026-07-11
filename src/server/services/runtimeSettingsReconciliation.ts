import { config } from '../config.js';
import { hydrateRuntimeSettingsFromPersistedSnapshot } from '../runtimeSettingsHydration.js';
import {
  updateBalanceRefreshCron,
  updateCheckinSchedule,
  updateLogCleanupSettings,
} from './checkinScheduler.js';
import {
  startModelAvailabilityProbeScheduler,
  stopModelAvailabilityProbeScheduler,
} from './modelAvailabilityProbeService.js';
import {
  startProxyLogRetentionService,
  stopProxyLogRetentionService,
} from './proxyLogRetentionService.js';
import { invalidateSiteProxyCache } from './siteProxy.js';

type RuntimeSettingsReconciliationDependencies = {
  hydrate?: typeof hydrateRuntimeSettingsFromPersistedSnapshot;
  updateCheckin?: typeof updateCheckinSchedule;
  updateBalance?: typeof updateBalanceRefreshCron;
  updateLogCleanup?: typeof updateLogCleanupSettings;
  startModelProbe?: typeof startModelAvailabilityProbeScheduler;
  stopModelProbe?: typeof stopModelAvailabilityProbeScheduler;
  startLegacyLogRetention?: typeof startProxyLogRetentionService;
  stopLegacyLogRetention?: typeof stopProxyLogRetentionService;
  invalidateProxyCache?: typeof invalidateSiteProxyCache;
};

/** Rehydrates one persisted snapshot and reconciles every setting-owned runtime service. */
export async function reconcileRuntimeSettingsFromPersistedSnapshot(
  deps: RuntimeSettingsReconciliationDependencies = {},
): Promise<Map<string, string>> {
  const settingsMap = await (deps.hydrate ?? hydrateRuntimeSettingsFromPersistedSnapshot)();

  (deps.updateCheckin ?? updateCheckinSchedule)({
    mode: config.checkinScheduleMode,
    cronExpr: config.checkinCron,
    intervalHours: config.checkinIntervalHours,
  });
  (deps.updateBalance ?? updateBalanceRefreshCron)(config.balanceRefreshCron);
  (deps.updateLogCleanup ?? updateLogCleanupSettings)({
    cronExpr: config.logCleanupCron,
    usageLogsEnabled: config.logCleanupUsageLogsEnabled,
    programLogsEnabled: config.logCleanupProgramLogsEnabled,
    retentionDays: config.logCleanupRetentionDays,
  });

  if (config.logCleanupConfigured) {
    (deps.stopLegacyLogRetention ?? stopProxyLogRetentionService)();
  } else {
    (deps.startLegacyLogRetention ?? startProxyLogRetentionService)();
  }
  if (config.modelAvailabilityProbeEnabled) {
    (deps.startModelProbe ?? startModelAvailabilityProbeScheduler)();
  } else {
    (deps.stopModelProbe ?? stopModelAvailabilityProbeScheduler)();
  }
  (deps.invalidateProxyCache ?? invalidateSiteProxyCache)();
  return settingsMap;
}
