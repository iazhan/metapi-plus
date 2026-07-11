import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import {
  ACCOUNT_GROUP_RATE_REFRESH_DEFAULT_INTERVAL_MINUTES,
  normalizeAccountGroupRateRefreshIntervalMinutes,
} from '../shared/accountGroupRateRefresh.js';
import {
  refreshAccountGroupRates,
  type AccountRateRefreshFailureKind,
  type AccountWithSiteRow,
} from './accountRateSyncService.js';

const ACTIVE_STATUS = 'active';
const EXPIRED_STATUS = 'expired';
const RATE_REFRESH_BACKOFF_MS = [
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;

const SAFE_FAILURE_LABELS: Record<AccountRateRefreshFailureKind, string> = {
  auth: '账号会话失效且自动恢复失败',
  timeout: '上游倍率请求超时',
  invalid_response: '上游返回的倍率数据无效',
  upstream: '上游倍率接口请求失败',
  storage: '倍率快照保存失败',
};

export const ACCOUNT_RATE_REFRESH_CONCURRENCY = 3;

export type AccountRateRefreshSchedulerSettings = {
  enabled: boolean;
  intervalMinutes: number;
};

export type AccountRateRefreshSchedulerStopOptions = {
  resumePendingUpdates?: boolean;
};

export type AccountRateRefreshPassResult = {
  scanned: number;
  candidates: number;
  synced: number;
  skipped: number;
  deferred: number;
  failed: number;
  recovered: number;
  durationMs: number;
  syncedAccountIds: number[];
  failedAccountIds: number[];
  deferredAccountIds: number[];
};

type AccountRateRefreshFailureState = {
  consecutiveFailures: number;
  nextEligibleAt: number;
  failureNotified: boolean;
  lastFailureKind: AccountRateRefreshFailureKind;
};

const failureStateByAccountId = new Map<number, AccountRateRefreshFailureState>();

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let scheduledPassInFlight: Promise<void> | null = null;
let accountRateRefreshPassInFlight: Promise<AccountRateRefreshPassResult> | null = null;
let accountRateRefreshPassController: AbortController | null = null;
let schedulerEnabled = false;
let schedulerIntervalMinutes = ACCOUNT_GROUP_RATE_REFRESH_DEFAULT_INTERVAL_MINUTES;
let schedulerGeneration = 0;
let schedulerSuspended = false;
let schedulerStopInFlight: Promise<void> | null = null;
let lifecycleCommandSequence = 0;
let latestLifecycleCommand: {
  sequence: number;
  kind: 'start' | 'update' | 'stop';
  settings: AccountRateRefreshSchedulerSettings | null;
} = { sequence: 0, kind: 'stop', settings: null };
let drainResumePendingUpdates = true;

function normalizeLifecycleStatus(value?: string | null): string {
  if (typeof value !== 'string') return ACTIVE_STATUS;
  const normalized = value.trim().toLowerCase();
  return normalized || ACTIVE_STATUS;
}

function clearSchedulerTimer(): void {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}

async function createFailureEvent(
  account: typeof schema.accounts.$inferSelect,
  failureKind: AccountRateRefreshFailureKind,
  nowMs: number,
): Promise<void> {
  await db.insert(schema.events).values({
    type: 'token',
    title: '自动倍率刷新失败',
    message: SAFE_FAILURE_LABELS[failureKind],
    level: failureKind === 'auth' ? 'error' : 'warning',
    relatedId: account.id,
    relatedType: 'account',
    createdAt: new Date(nowMs).toISOString(),
  }).run();
}

async function createRecoveryEvent(account: typeof schema.accounts.$inferSelect, nowMs: number): Promise<void> {
  await db.insert(schema.events).values({
    type: 'token',
    title: '自动倍率刷新已恢复',
    message: '账号倍率刷新已恢复正常',
    level: 'info',
    relatedId: account.id,
    relatedType: 'account',
    createdAt: new Date(nowMs).toISOString(),
  }).run();
}

export function computeAccountRateRefreshBackoffMs(failureCount: number): number {
  const index = Math.max(0, Math.min(RATE_REFRESH_BACKOFF_MS.length - 1, Math.trunc(failureCount) - 1));
  return RATE_REFRESH_BACKOFF_MS[index];
}

/** Clears scheduler-owned failure and backoff state after a successful account restore/reset. */
export function clearAccountRateRefreshFailureState(accountId: number): void {
  failureStateByAccountId.delete(accountId);
}

function createEmptyPassResult(): AccountRateRefreshPassResult {
  return {
    scanned: 0,
    candidates: 0,
    synced: 0,
    skipped: 0,
    deferred: 0,
    failed: 0,
    recovered: 0,
    durationMs: 0,
    syncedAccountIds: [],
    failedAccountIds: [],
    deferredAccountIds: [],
  };
}

async function executeOneAccount(
  row: AccountWithSiteRow,
  nowMs: number,
  counters: AccountRateRefreshPassResult,
  generation: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || generation !== schedulerGeneration) return;
  const accountId = row.accounts.id;
  const outcome = await refreshAccountGroupRates(row, { signal }).catch(() => ({
    rateSync: { status: 'failed' as const, message: 'account rate refresh failed' },
    recoveredSession: false,
    failureKind: 'upstream' as const,
  }));
  if (signal.aborted || generation !== schedulerGeneration) return;
  const rateSync = outcome.rateSync;

  if (rateSync.status === 'synced') {
    const previousFailure = failureStateByAccountId.get(accountId);
    counters.synced += 1;
    counters.syncedAccountIds.push(accountId);
    if (previousFailure?.failureNotified) {
      counters.recovered += 1;
      try {
        await createRecoveryEvent(row.accounts, nowMs);
        failureStateByAccountId.delete(accountId);
      } catch {
        console.warn('[account-rate-refresh] failed to persist recovery event');
        failureStateByAccountId.set(accountId, {
          ...previousFailure,
          nextEligibleAt: 0,
        });
      }
    } else {
      failureStateByAccountId.delete(accountId);
    }
    return;
  }

  if (rateSync.status === 'failed') {
    const failureKind = outcome.failureKind ?? 'upstream';
    const previousFailure = failureStateByAccountId.get(accountId);
    const consecutiveFailures = (previousFailure?.consecutiveFailures ?? 0) + 1;
    let failureNotified = previousFailure?.failureNotified ?? false;
    if (!failureNotified) {
      try {
        await createFailureEvent(row.accounts, failureKind, nowMs);
        failureNotified = true;
      } catch {
        console.warn('[account-rate-refresh] failed to persist failure event');
      }
    }
    failureStateByAccountId.set(accountId, {
      consecutiveFailures,
      nextEligibleAt: nowMs + computeAccountRateRefreshBackoffMs(consecutiveFailures),
      failureNotified,
      lastFailureKind: failureKind,
    });
    counters.failed += 1;
    counters.failedAccountIds.push(accountId);
    return;
  }

  counters.skipped += 1;
}

async function executeAccountRateRefreshPassInternal(
  input: { nowMs?: number } = {},
  generation: number,
  signal: AbortSignal,
): Promise<AccountRateRefreshPassResult> {
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const startedAt = Date.now();
  const counters = createEmptyPassResult();
  if (signal.aborted || generation !== schedulerGeneration) return counters;
  const rows = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();
  if (signal.aborted || generation !== schedulerGeneration) return counters;

  counters.scanned = rows.length;
  const eligibleRows: AccountWithSiteRow[] = [];
  for (const row of rows) {
    const accountStatus = normalizeLifecycleStatus(row.accounts.status);
    const siteStatus = normalizeLifecycleStatus(row.sites.status);
    if (siteStatus !== ACTIVE_STATUS || (accountStatus !== ACTIVE_STATUS && accountStatus !== EXPIRED_STATUS)) {
      counters.skipped += 1;
      continue;
    }

    counters.candidates += 1;
    const failureState = failureStateByAccountId.get(row.accounts.id);
    if (failureState && failureState.nextEligibleAt > nowMs) {
      counters.deferred += 1;
      counters.deferredAccountIds.push(row.accounts.id);
      continue;
    }
    eligibleRows.push(row);
  }

  let cursor = 0;
  const workerCount = Math.max(
    1,
    Math.min(ACCOUNT_RATE_REFRESH_CONCURRENCY, eligibleRows.length || 1),
  );
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      if (signal.aborted || generation !== schedulerGeneration) return;
      const row = eligibleRows[cursor];
      cursor += 1;
      if (!row) return;
      await executeOneAccount(row, nowMs, counters, generation, signal);
    }
  }));

  counters.durationMs = Math.max(0, Date.now() - startedAt);
  return counters;
}

export async function executeAccountRateRefreshPass(input: { nowMs?: number } = {}): Promise<AccountRateRefreshPassResult> {
  if (accountRateRefreshPassInFlight) return accountRateRefreshPassInFlight;
  if (schedulerSuspended) return createEmptyPassResult();

  const generation = schedulerGeneration;
  const controller = new AbortController();
  let pass: Promise<AccountRateRefreshPassResult>;
  pass = executeAccountRateRefreshPassInternal(input, generation, controller.signal)
    .finally(() => {
      if (accountRateRefreshPassInFlight === pass) {
        accountRateRefreshPassInFlight = null;
        accountRateRefreshPassController = null;
      }
    });
  accountRateRefreshPassInFlight = pass;
  accountRateRefreshPassController = controller;
  return pass;
}

function logPassSummary(result: AccountRateRefreshPassResult): void {
  console.info(
    `[account-rate-refresh] pass complete: scanned=${result.scanned} candidates=${result.candidates} synced=${result.synced} skipped=${result.skipped} deferred=${result.deferred} failed=${result.failed} recovered=${result.recovered} durationMs=${result.durationMs}`,
  );
}

async function runScheduledPass(generation: number): Promise<void> {
  if (schedulerSuspended || !schedulerEnabled || generation !== schedulerGeneration) return;
  if (scheduledPassInFlight) {
    console.info('[account-rate-refresh] skipped overlapping scheduled pass');
    return scheduledPassInFlight;
  }
  if (accountRateRefreshPassInFlight) {
    console.info('[account-rate-refresh] skipped overlapping scheduled pass');
    return accountRateRefreshPassInFlight
      .then(() => undefined)
      .catch(() => {
        console.warn('[account-rate-refresh] scheduled pass failed');
      });
  }

  let pass: Promise<void>;
  pass = executeAccountRateRefreshPass()
    .then((result) => {
      if (generation === schedulerGeneration) logPassSummary(result);
    })
    .catch(() => {
      console.warn('[account-rate-refresh] scheduled pass failed');
    })
    .finally(() => {
      if (scheduledPassInFlight === pass) {
        scheduledPassInFlight = null;
      }
    });
  scheduledPassInFlight = pass;
  return pass;
}

function scheduleInterval(generation: number): void {
  schedulerTimer = setInterval(() => {
    if (schedulerSuspended || !schedulerEnabled || generation !== schedulerGeneration) return;
    void runScheduledPass(generation);
  }, schedulerIntervalMinutes * 60_000);
  schedulerTimer.unref?.();
}

function applySchedulerSettings(
  settings: AccountRateRefreshSchedulerSettings,
): AccountRateRefreshSchedulerSettings {
  const previouslyEnabled = schedulerEnabled;
  clearSchedulerTimer();
  schedulerEnabled = settings.enabled;
  schedulerIntervalMinutes = settings.intervalMinutes;
  if (!schedulerEnabled) {
    return { enabled: false, intervalMinutes: schedulerIntervalMinutes };
  }

  if (!previouslyEnabled) {
    void runScheduledPass(schedulerGeneration);
  }
  scheduleInterval(schedulerGeneration);
  return { enabled: true, intervalMinutes: schedulerIntervalMinutes };
}

export function startAccountRateRefreshScheduler(): AccountRateRefreshSchedulerSettings {
  return issueSchedulerSettingsCommand({
    enabled: config.accountGroupRateRefreshEnabled,
    intervalMinutes: config.accountGroupRateRefreshIntervalMinutes,
  }, 'start');
}

function issueSchedulerSettingsCommand(
  settings: AccountRateRefreshSchedulerSettings,
  kind: 'start' | 'update',
): AccountRateRefreshSchedulerSettings {
  const intervalMinutes = normalizeAccountGroupRateRefreshIntervalMinutes(settings.intervalMinutes);
  if (intervalMinutes === null) {
    throw new Error('invalid account rate refresh interval');
  }

  const normalizedSettings = { enabled: settings.enabled, intervalMinutes };
  latestLifecycleCommand = {
    sequence: ++lifecycleCommandSequence,
    kind,
    settings: normalizedSettings,
  };
  if (schedulerStopInFlight) {
    clearSchedulerTimer();
    schedulerEnabled = false;
    schedulerIntervalMinutes = intervalMinutes;
    return { enabled: false, intervalMinutes: schedulerIntervalMinutes };
  }
  schedulerSuspended = false;
  return applySchedulerSettings(normalizedSettings);
}

export function updateAccountRateRefreshScheduler(
  settings: AccountRateRefreshSchedulerSettings,
): AccountRateRefreshSchedulerSettings {
  return issueSchedulerSettingsCommand(settings, 'update');
}

export function stopAccountRateRefreshScheduler(
  options: AccountRateRefreshSchedulerStopOptions = {},
): Promise<void> {
  const stopSequence = ++lifecycleCommandSequence;
  latestLifecycleCommand = { sequence: stopSequence, kind: 'stop', settings: null };
  drainResumePendingUpdates = options.resumePendingUpdates !== false;
  schedulerSuspended = true;
  clearSchedulerTimer();
  schedulerEnabled = false;
  accountRateRefreshPassController?.abort(
    new DOMException('Account rate refresh scheduler stopped', 'AbortError'),
  );

  if (schedulerStopInFlight) {
    return schedulerStopInFlight;
  }

  schedulerGeneration += 1;
  const ownedPasses: Promise<unknown>[] = [];
  if (scheduledPassInFlight) ownedPasses.push(scheduledPassInFlight);
  if (accountRateRefreshPassInFlight) ownedPasses.push(accountRateRefreshPassInFlight);

  let drain: Promise<void>;
  drain = Promise.allSettled(ownedPasses)
    .then(() => undefined)
    .finally(() => {
      if (schedulerStopInFlight !== drain) return;
      schedulerStopInFlight = null;
      const command = latestLifecycleCommand;
      if (command.sequence <= stopSequence || !command.settings) return;
      if (command.kind === 'update' && !drainResumePendingUpdates) return;
      schedulerSuspended = false;
      applySchedulerSettings(command.settings);
    });
  schedulerStopInFlight = drain;
  return drain;
}

export async function __resetAccountRateRefreshSchedulerForTests(): Promise<void> {
  await stopAccountRateRefreshScheduler({ resumePendingUpdates: false });
  schedulerTimer = null;
  scheduledPassInFlight = null;
  accountRateRefreshPassInFlight = null;
  accountRateRefreshPassController = null;
  schedulerStopInFlight = null;
  failureStateByAccountId.clear();
  schedulerIntervalMinutes = ACCOUNT_GROUP_RATE_REFRESH_DEFAULT_INTERVAL_MINUTES;
  schedulerSuspended = false;
}
