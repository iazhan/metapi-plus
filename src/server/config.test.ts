import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildConfig, buildFastifyOptions } from './config.js';

describe('buildConfig', () => {
  it('defaults to external listen host for server deployments', () => {
    const config = buildConfig({});

    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.port).toBe(4000);
    expect(config.dataDir).toBe('./data');
  });

  it('aligns desktop deployments with server deployments for listen host', () => {
    const config = buildConfig({
      HOST: '0.0.0.0',
      METAPI_DESKTOP: '1',
      PORT: '4312',
      DATA_DIR: '/tmp/metapi-data',
    });

    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.port).toBe(4312);
    expect(config.dataDir).toBe('/tmp/metapi-data');
  });

  it('honors explicit loopback host outside desktop mode', () => {
    const config = buildConfig({
      HOST: '127.0.0.1',
    });

    expect(config.listenHost).toBe('127.0.0.1');
  });

  it('defaults telegram api base url to the official endpoint', () => {
    const config = buildConfig({});

    expect(config.telegramApiBaseUrl).toBe('https://api.telegram.org');
    expect(config.telegramMessageThreadId).toBe('');
  });

  it('accepts telegram message thread id from environment', () => {
    const config = buildConfig({
      TELEGRAM_MESSAGE_THREAD_ID: '77',
    });

    expect(config.telegramMessageThreadId).toBe('77');
  });

  it('accepts JSON request bodies larger than Fastify default 1 MiB', async () => {
    const app = Fastify(buildFastifyOptions(buildConfig({})));
    const largeText = 'a'.repeat(2 * 1024 * 1024);

    app.post('/echo', async (request) => {
      const body = request.body as { text?: string };
      return { textLength: body.text?.length ?? 0 };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { text: largeText },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ textLength: largeText.length });
    await app.close();
  });

  it('trusts forwarded client IP headers for reverse-proxy deployments', async () => {
    const app = Fastify(buildFastifyOptions(buildConfig({})));

    app.get('/ip', async (request) => ({
      ip: request.ip,
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.8',
      headers: {
        'x-forwarded-for': '203.0.113.5, 10.0.0.8',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ip: '203.0.113.5' });
    await app.close();
  });

  it('defaults account group rate refresh to enabled every 30 minutes', () => {
    const built = buildConfig({});
    expect(built.accountGroupRateRefreshEnabled).toBe(true);
    expect(built.accountGroupRateRefreshIntervalMinutes).toBe(30);
  });

  it('defaults automatic check-in and balance refresh to enabled and accepts environment overrides', () => {
    expect(buildConfig({})).toMatchObject({
      checkinEnabled: true,
      balanceRefreshEnabled: true,
    });
    expect(buildConfig({
      CHECKIN_ENABLED: 'false',
      BALANCE_REFRESH_ENABLED: 'false',
    })).toMatchObject({
      checkinEnabled: false,
      balanceRefreshEnabled: false,
    });
  });

  it('reads valid account group rate refresh environment values and rejects invalid intervals', () => {
    expect(buildConfig({
      ACCOUNT_GROUP_RATE_REFRESH_ENABLED: 'false',
      ACCOUNT_GROUP_RATE_REFRESH_INTERVAL_MINUTES: '5',
    })).toMatchObject({
      accountGroupRateRefreshEnabled: false,
      accountGroupRateRefreshIntervalMinutes: 5,
    });

    expect(buildConfig({
      ACCOUNT_GROUP_RATE_REFRESH_INTERVAL_MINUTES: '4',
    }).accountGroupRateRefreshIntervalMinutes).toBe(30);
  });
});
