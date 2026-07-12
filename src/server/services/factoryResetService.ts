import { buildConfig, config } from '../config.js';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import {
  captureRuntimeSettingsSnapshot,
  restoreRuntimeSettingsSnapshot,
} from '../runtimeSettingsHydration.js';
import { updateBalanceRefreshCron, updateCheckinCron, updateLogCleanupSettings } from './checkinScheduler.js';
import {
  DEFAULT_SITE_SEED_SETTING_KEY,
  ensureDefaultSitesSeeded,
} from './defaultSiteSeedService.js';
import { startProxyLogRetentionService } from './proxyLogRetentionService.js';
import { invalidateSiteProxyCache } from './siteProxy.js';
import {
  clearAccountRateRefreshFailureState,
  startAccountRateRefreshScheduler,
  stopAccountRateRefreshScheduler,
} from './accountRateRefreshScheduler.js';
import { runRuntimeMaintenance } from './runtimeMaintenanceOwner.js';
import {
  startPriceRefreshScheduler,
  stopPriceRefreshScheduler,
} from '../pricing/priceRefreshScheduler.js';
import {
  PRICE_REFRESH_DEFAULT_CRON,
  PRICE_REFRESH_DEFAULT_ENABLED,
} from '../pricing/settings.js';

export const FACTORY_RESET_ADMIN_TOKEN = 'change-me-admin-token';

type FactoryResetDependencies = {
  // Retained as ignored compatibility seams for focused callers proving reset never switches DBs.
  switchRuntimeDatabase?: (...args: unknown[]) => Promise<void> | void;
  runSqliteMigrations?: () => Promise<void> | void;
  ensureDefaultSitesSeeded?: typeof ensureDefaultSitesSeeded;
  startAccountRateRefreshScheduler?: typeof startAccountRateRefreshScheduler;
  stopAccountRateRefreshScheduler?: typeof stopAccountRateRefreshScheduler;
  clearAccountRateRefreshFailureState?: typeof clearAccountRateRefreshFailureState;
  startPriceRefreshScheduler?: typeof startPriceRefreshScheduler;
  stopPriceRefreshScheduler?: typeof stopPriceRefreshScheduler;
  restorePriorRuntime?: () => Promise<void>;
};

type PreservedInfrastructureState = {
  authToken: string;
  proxyToken: string;
  systemProxyUrl: string;
  dbType: 'sqlite' | 'mysql' | 'postgres';
  dbUrl: string;
  dbSsl: boolean;
};

const FACTORY_RESET_DEFAULT_SITES: Array<typeof schema.sites.$inferInsert> = [
  { name: 'OpenAI 官方', url: 'https://api.openai.com', platform: 'openai', status: 'active', useSystemProxy: false, isPinned: false, globalWeight: 1, sortOrder: 0 },
  { name: 'Claude 官方', url: 'https://api.anthropic.com', platform: 'claude', status: 'active', useSystemProxy: false, isPinned: false, globalWeight: 1, sortOrder: 1 },
  { name: 'Gemini 官方', url: 'https://generativelanguage.googleapis.com', platform: 'gemini', status: 'active', useSystemProxy: false, isPinned: false, globalWeight: 1, sortOrder: 2 },
  { name: 'CLIProxyAPI', url: 'http://127.0.0.1:8317', platform: 'cliproxyapi', status: 'active', useSystemProxy: false, isPinned: false, globalWeight: 1, sortOrder: 3 },
];

async function clearAllBusinessData(tx: typeof db): Promise<void> {
  await tx.delete(schema.pricingRefreshStates).run();
  await tx.delete(schema.siteModelPriceRules).run();
  await tx.delete(schema.siteModelPrices).run();
  await tx.delete(schema.officialModelPrices).run();
  await tx.delete(schema.sitePricingProfiles).run();
  await tx.delete(schema.accountGroupRateRules).run();
  await tx.delete(schema.routeChannels).run();
  await tx.delete(schema.routeGroupSources).run();
  await tx.delete(schema.tokenModelAvailability).run();
  await tx.delete(schema.modelAvailability).run();
  await tx.delete(schema.proxyLogs).run();
  await tx.delete(schema.proxyVideoTasks).run();
  await tx.delete(schema.proxyFiles).run();
  await tx.delete(schema.checkinLogs).run();
  await tx.delete(schema.siteAnnouncements).run();
  await tx.delete(schema.siteDisabledModels).run();
  await tx.delete(schema.accountGroupRates).run();
  await tx.delete(schema.accountTokens).run();
  await tx.delete(schema.accounts).run();
  await tx.delete(schema.tokenRoutes).run();
  await tx.delete(schema.siteApiEndpoints).run();
  await tx.delete(schema.sites).run();
  await tx.delete(schema.downstreamApiKeys).run();
  await tx.delete(schema.events).run();
  await tx.delete(schema.settings).run();
}

function captureInfrastructureState(): PreservedInfrastructureState {
  return {
    authToken: config.authToken,
    proxyToken: config.proxyToken,
    systemProxyUrl: config.systemProxyUrl,
    dbType: config.dbType,
    dbUrl: config.dbUrl,
    dbSsl: config.dbSsl,
  };
}

function resetRuntimeConfigToInitialState(preserved: PreservedInfrastructureState): void {
  const baseline = buildConfig(process.env);
  Object.assign(config, baseline, {
    authToken: preserved.authToken || baseline.authToken || FACTORY_RESET_ADMIN_TOKEN,
    proxyToken: preserved.proxyToken || baseline.proxyToken,
    systemProxyUrl: preserved.systemProxyUrl || baseline.systemProxyUrl,
    dbType: preserved.dbType,
    dbUrl: preserved.dbUrl,
    dbSsl: preserved.dbSsl,
  });
  config.logCleanupConfigured = false;
  config.logCleanupUsageLogsEnabled = config.proxyLogRetentionDays > 0;
  config.logCleanupProgramLogsEnabled = false;
  config.logCleanupRetentionDays = Math.max(1, Math.trunc(
    config.proxyLogRetentionDays || config.logCleanupRetentionDays || 30,
  ));
  updateCheckinCron(config.checkinCron);
  updateBalanceRefreshCron(config.balanceRefreshCron);
  updateLogCleanupSettings({
    cronExpr: config.logCleanupCron,
    usageLogsEnabled: config.logCleanupUsageLogsEnabled,
    programLogsEnabled: config.logCleanupProgramLogsEnabled,
    retentionDays: config.logCleanupRetentionDays,
  });
  startProxyLogRetentionService();
  invalidateSiteProxyCache();
}

async function restoreInfrastructureSettings(
  preserved: PreservedInfrastructureState,
  tx: typeof db,
): Promise<void> {
  await upsertSetting('auth_token', preserved.authToken || FACTORY_RESET_ADMIN_TOKEN, tx);
  await upsertSetting('proxy_token', preserved.proxyToken, tx);
  await upsertSetting('system_proxy_url', preserved.systemProxyUrl, tx);
  await upsertSetting('db_type', preserved.dbType, tx);
  await upsertSetting('db_url', preserved.dbUrl, tx);
  await upsertSetting('db_ssl', preserved.dbSsl, tx);
  await upsertSetting('price_refresh_enabled', PRICE_REFRESH_DEFAULT_ENABLED, tx);
  await upsertSetting('price_refresh_cron', PRICE_REFRESH_DEFAULT_CRON, tx);
}

async function seedFactoryDefaults(tx: typeof db): Promise<void> {
  await tx.insert(schema.sites).values(FACTORY_RESET_DEFAULT_SITES).run();
  await upsertSetting(DEFAULT_SITE_SEED_SETTING_KEY, true, tx);
}

export async function performFactoryReset(deps: FactoryResetDependencies = {}): Promise<void> {
  const stopScheduler = deps.stopAccountRateRefreshScheduler ?? stopAccountRateRefreshScheduler;
  const startScheduler = deps.startAccountRateRefreshScheduler ?? startAccountRateRefreshScheduler;
  const clearFailure = deps.clearAccountRateRefreshFailureState ?? clearAccountRateRefreshFailureState;
  const stopPriceScheduler = deps.stopPriceRefreshScheduler ?? stopPriceRefreshScheduler;
  const startPriceScheduler = deps.startPriceRefreshScheduler ?? startPriceRefreshScheduler;
  const preserved = captureInfrastructureState();
  const priorRuntime = captureRuntimeSettingsSnapshot();

  await runRuntimeMaintenance('factory-reset', async ({ markCommitted }) => {
    const accountIds = (await db.select({ id: schema.accounts.id }).from(schema.accounts).all())
      .map((row) => row.id);

    await db.transaction(async (tx) => {
      await clearAllBusinessData(tx as typeof db);
      await restoreInfrastructureSettings(preserved, tx as typeof db);
      if (deps.ensureDefaultSitesSeeded) {
        await deps.ensureDefaultSitesSeeded();
      } else {
        await seedFactoryDefaults(tx as typeof db);
      }
    });
    markCommitted();

    resetRuntimeConfigToInitialState(preserved);
    for (const accountId of accountIds) clearFailure(accountId);
  }, {
    stop: async () => {
      await Promise.all([
        stopScheduler({ resumePendingUpdates: false }),
        stopPriceScheduler(),
      ]);
    },
    start: async () => {
      startScheduler();
      await startPriceScheduler({
        enabled: config.priceRefreshEnabled,
        cronExpr: config.priceRefreshCron,
      });
    },
    restorePriorRuntime: deps.restorePriorRuntime ?? (async () => {
      restoreRuntimeSettingsSnapshot(priorRuntime);
    }),
  });
}
