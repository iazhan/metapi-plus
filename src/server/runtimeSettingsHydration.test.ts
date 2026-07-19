import { afterEach, describe, expect, it } from 'vitest';

import { config } from './config.js';
import { applyRuntimeSettings } from './runtimeSettingsHydration.js';

const originalConfig = structuredClone(config);

afterEach(() => {
  Object.assign(config, structuredClone(originalConfig));
});

describe('applyRuntimeSettings', () => {
  it('hydrates persisted runtime settings that should survive restarts', () => {
    config.disableCrossProtocolFallback = false;
    config.responsesCompactFallbackToResponsesEnabled = false;
    config.webhookEnabled = true;
    config.barkEnabled = true;
    config.serverChanEnabled = true;
    config.globalAllowedModels = [];

    applyRuntimeSettings(new Map([
      ['disable_cross_protocol_fallback', JSON.stringify(true)],
      ['responses_compact_fallback_to_responses_enabled', JSON.stringify(true)],
      ['webhook_enabled', JSON.stringify(false)],
      ['bark_enabled', JSON.stringify(false)],
      ['serverchan_enabled', JSON.stringify(false)],
      ['global_allowed_models', JSON.stringify(['gpt-5.4', ' claude-3.7-sonnet '])],
    ]));

    expect(config.disableCrossProtocolFallback).toBe(true);
    expect(config.responsesCompactFallbackToResponsesEnabled).toBe(true);
    expect(config.webhookEnabled).toBe(false);
    expect(config.barkEnabled).toBe(false);
    expect(config.serverChanEnabled).toBe(false);
    expect(config.globalAllowedModels).toEqual(['gpt-5.4', 'claude-3.7-sonnet']);
  });

  it('normalizes smtpPort to a positive integer during hydration', () => {
    config.smtpPort = 587;

    applyRuntimeSettings(new Map([
      ['smtp_port', JSON.stringify(587.9)],
    ]));

    expect(config.smtpPort).toBe(587);
  });

  it('hydrates legacy double-encoded global model allowlist values', () => {
    config.globalAllowedModels = [];

    applyRuntimeSettings(new Map([
      ['global_allowed_models', JSON.stringify(JSON.stringify(['model-alpha', ' model-beta ', 'model-gamma']))],
    ]));

    expect(config.globalAllowedModels).toEqual(['model-alpha', 'model-beta', 'model-gamma']);
  });

  it('hydrates valid account group rate refresh settings and ignores invalid intervals', () => {
    config.accountGroupRateRefreshEnabled = true;
    config.accountGroupRateRefreshIntervalMinutes = 30;

    applyRuntimeSettings(new Map([
      ['account_group_rate_refresh_enabled', JSON.stringify(false)],
      ['account_group_rate_refresh_interval_minutes', JSON.stringify(45)],
    ]));

    expect(config.accountGroupRateRefreshEnabled).toBe(false);
    expect(config.accountGroupRateRefreshIntervalMinutes).toBe(45);

    applyRuntimeSettings(new Map([
      ['account_group_rate_refresh_interval_minutes', JSON.stringify(4)],
    ]));

    expect(config.accountGroupRateRefreshIntervalMinutes).toBe(45);
  });

  it('hydrates independent price refresh settings', () => {
    config.priceRefreshEnabled = true;
    config.priceRefreshCron = '0 0 * * *';

    applyRuntimeSettings(new Map([
      ['price_refresh_enabled', JSON.stringify(false)],
      ['price_refresh_cron', JSON.stringify('0 6 * * *')],
    ]));

    expect(config.priceRefreshEnabled).toBe(false);
    expect(config.priceRefreshCron).toBe('0 6 * * *');
  });

  it('hydrates disabled automatic check-in and balance refresh settings', () => {
    config.checkinEnabled = true;
    config.balanceRefreshEnabled = true;

    applyRuntimeSettings(new Map([
      ['checkin_enabled', JSON.stringify(false)],
      ['balance_refresh_enabled', JSON.stringify(false)],
    ]));

    expect(config.checkinEnabled).toBe(false);
    expect(config.balanceRefreshEnabled).toBe(false);
  });

  it('derives explicit log cleanup ownership from the complete settings snapshot', () => {
    config.logCleanupConfigured = false;
    applyRuntimeSettings(new Map([
      ['log_cleanup_retention_days', JSON.stringify(14)],
    ]));
    expect(config.logCleanupConfigured).toBe(true);

    config.logCleanupConfigured = true;
    applyRuntimeSettings(new Map());
    expect(config.logCleanupConfigured).toBe(false);
  });
});
