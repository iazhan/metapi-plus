import cron, { type ScheduledTask } from 'node-cron';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { runPriceRefreshPass, type PriceRefreshPassInput, type PriceRefreshPassResult } from './priceRefreshService.js';
import {
  getPriceRefreshTimeZone,
  PRICE_REFRESH_DEFAULT_CRON,
  PRICE_REFRESH_DEFAULT_ENABLED,
  PRICE_REFRESH_DEFAULT_INTERVAL_HOURS,
  PRICE_REFRESH_DEFAULT_SCHEDULE_MODE,
} from './settings.js';

export {
  getPriceRefreshTimeZone,
  PRICE_REFRESH_DEFAULT_CRON,
  PRICE_REFRESH_DEFAULT_ENABLED,
  PRICE_REFRESH_DEFAULT_INTERVAL_HOURS,
  PRICE_REFRESH_DEFAULT_SCHEDULE_MODE,
};

export interface PriceRefreshSchedulerSettings {
  enabled: boolean;
  cronExpr: string;
  scheduleMode?: 'cron' | 'interval';
  intervalHours?: number;
}

type ScheduledTaskLike = Pick<ScheduledTask, 'stop' | 'destroy'>;
export interface PriceRefreshSchedulerDependencies {
  runPass: (input?: PriceRefreshPassInput) => Promise<PriceRefreshPassResult | object>;
  schedule: (
    expression: string,
    callback: () => void,
    options: { timezone: string },
  ) => ScheduledTaskLike;
  needsImmediateRefresh: () => Promise<boolean>;
  timeZone: () => string;
}

async function needsImmediateRefresh(): Promise<boolean> {
  const official = await db.select({ id: schema.officialModelPrices.id })
    .from(schema.officialModelPrices).limit(1).get();
  if (!official) return true;
  const activeSites = await db.select({ id: schema.sites.id }).from(schema.sites)
    .where(eq(schema.sites.status, 'active')).all();
  if (activeSites.length === 0) return false;
  const pricedSites = await db.select({ siteId: schema.siteModelPrices.siteId })
    .from(schema.siteModelPrices).all();
  const pricedSiteIds = new Set(pricedSites.map((row) => row.siteId));
  return activeSites.some((site) => !pricedSiteIds.has(site.id));
}

const defaultDependencies: PriceRefreshSchedulerDependencies = {
  runPass: runPriceRefreshPass,
  schedule: (expression, callback, options) => cron.schedule(expression, callback, options),
  needsImmediateRefresh,
  timeZone: getPriceRefreshTimeZone,
};

export function createPriceRefreshScheduler(deps: PriceRefreshSchedulerDependencies = defaultDependencies) {
  let task: ScheduledTaskLike | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<PriceRefreshPassResult | object> | null = null;
  let controller: AbortController | null = null;
  let enabled = false;
  let stopped = false;

  const trigger = (): Promise<PriceRefreshPassResult | object> => {
    if (stopped) return Promise.reject(new Error('price refresh scheduler is stopped'));
    if (inFlight) return inFlight;
    controller = new AbortController();
    const current = deps.runPass({ signal: controller.signal }).finally(() => {
      if (inFlight === current) {
        inFlight = null;
        controller = null;
      }
    });
    inFlight = current;
    return current;
  };

  const start = async (settings: PriceRefreshSchedulerSettings): Promise<void> => {
    stopped = false;
    task?.stop();
    task?.destroy();
    task = null;
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    enabled = settings.enabled;
    if (!enabled) return;
    const scheduleMode = settings.scheduleMode ?? PRICE_REFRESH_DEFAULT_SCHEDULE_MODE;
    if (scheduleMode === 'cron') {
      task = deps.schedule(settings.cronExpr, () => {
        void trigger().catch(() => undefined);
      }, { timezone: deps.timeZone() });
    } else {
      const intervalHours = settings.intervalHours ?? PRICE_REFRESH_DEFAULT_INTERVAL_HOURS;
      if (!Number.isFinite(intervalHours) || intervalHours < 1 || intervalHours > 24) {
        throw new Error(`Invalid price refresh interval hours: ${String(intervalHours)}`);
      }
      intervalTimer = setInterval(() => {
        void trigger().catch(() => undefined);
      }, Math.trunc(intervalHours) * 60 * 60 * 1000);
      intervalTimer.unref?.();
    }
    if (await deps.needsImmediateRefresh()) {
      void trigger().catch(() => undefined);
    }
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    enabled = false;
    task?.stop();
    task?.destroy();
    task = null;
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    controller?.abort();
    if (inFlight) await inFlight.catch((error) => {
      if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
    });
  };

  return { start, trigger, stop, isEnabled: () => enabled };
}

const singleton = createPriceRefreshScheduler();

export function startPriceRefreshScheduler(settings: PriceRefreshSchedulerSettings): Promise<void> {
  if ((settings.scheduleMode ?? PRICE_REFRESH_DEFAULT_SCHEDULE_MODE) === 'cron' && !cron.validate(settings.cronExpr)) {
    throw new Error('Invalid price refresh cron');
  }
  return singleton.start(settings);
}

export function updatePriceRefreshScheduler(settings: PriceRefreshSchedulerSettings): Promise<void> {
  return startPriceRefreshScheduler(settings);
}

export function triggerPriceRefresh(): Promise<PriceRefreshPassResult | object> {
  return singleton.trigger();
}

export function stopPriceRefreshScheduler(): Promise<void> {
  return singleton.stop();
}
