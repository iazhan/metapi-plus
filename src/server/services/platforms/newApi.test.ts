import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NewApiAdapter } from './newApi.js';

vi.mock('../siteProxy.js', () => ({
  withSiteProxyRequestInit: (_url: string, options: unknown) => options,
}));

interface RequestSnapshot {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

const COOKIE_SESSION_TOKEN = 'cookie-session-token';
const COOKIE_REQUIRES_USER_TOKEN = 'cookie-requires-user';
const COOKIE_REQUIRES_X_USER_ID_TOKEN = 'cookie-requires-x-user-id';
const CHECKIN_ALREADY_TOKEN = 'checkin-already-token';
const CHECKIN_INVALID_URL_TOKEN = 'checkin-invalid-url-token';
const CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN = 'checkin-invalid-url-expired-session-token';
const CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN = 'checkin-invalid-url-forbidden-session-token';
const CHECKIN_CLOUDFLARE_530_TOKEN = 'checkin-cloudflare-530-token';
const BALANCE_FAIL_TOKEN = 'balance-fail-token';
const BALANCE_SHIELD_FAILURE_TOKEN = 'balance-shield-failure-token';
const GROUP_EXPIRED_TOKEN = 'group-expired-token';
const SHIELD_LOGIN_USERNAME = 'shield-user';
const SHIELD_LOGIN_PASSWORD = 'shield-pass';
const SHIELD_LOGIN_TOKEN = 'login-session-token';
const SHIELD_LOGIN_USER_ID = 11494;
const SHIELD_LOGIN_COOKIE = 'challenge-seed';
const COOKIE_ONLY_LOGIN_USERNAME = 'cookie-only-user';
const COOKIE_ONLY_LOGIN_PASSWORD = 'cookie-only-pass';
const COOKIE_ONLY_LOGIN_SESSION = 'cookie-only-session';
const COOKIE_ONLY_LOGIN_USER_ID = 22001;
const TWO_FACTOR_LOGIN_USERNAME = 'two-factor-user';
const TWO_FACTOR_LOGIN_PASSWORD = 'two-factor-pass';
const TURNSTILE_LOGIN_USERNAME = 'turnstile-user';
const TURNSTILE_LOGIN_PASSWORD = 'turnstile-pass';
const INVALID_INTEGER_LOGIN_PASSWORD = 'invalid-integer-pass';
const INVALID_INTEGER_LOGIN_VALUES: Record<string, unknown> = {
  'invalid-integer-suffix': '42junk',
  'invalid-integer-decimal': 42.5,
  'invalid-integer-unsafe': Number.MAX_SAFE_INTEGER + 1,
};
const GROUP_RATE_TOKEN = 'group-rate-session-token';
const AUTO_ONLY_GROUP_RATE_TOKEN = 'auto-only-group-rate-session-token';
const MALFORMED_GROUP_RATE_TOKEN = 'malformed-group-rate-session-token';
const FAILED_GROUP_RATE_TOKEN = 'failed-group-rate-session-token';
const AMBIGUOUS_EMPTY_GROUP_RATE_TOKEN = 'ambiguous-empty-group-rate-session-token';
const EXPLICIT_EMPTY_GROUP_RATE_TOKEN = 'explicit-empty-group-rate-session-token';
const COOKIE_GROUP_RATE_TOKEN = 'session=cookie-group-rate-session-token';
const MALFORMED_BEARER_GROUP_RATE_TOKEN = 'session=malformed-bearer-group-rate-token';
const NON_AUTH_LOGIN_WORD_GROUP_RATE_TOKEN = 'session=non-auth-login-word-group-rate-token';
const NON_AUTH_EXPIRED_GROUP_RATE_TOKEN = 'session=non-auth-expired-group-rate-token';
const NON_SHIELD_HTML_GROUP_RATE_TOKEN = 'session=non-shield-html-group-rate-token';
const TOKEN_LIST_401_TOKEN = 'token-list-401-token';
const TOKEN_LIST_PERMISSION_DENIED_TOKEN = 'token-list-permission-denied-token';
const TOKEN_LIST_500_TOKEN = 'token-list-500-token';
const TOKEN_LIST_INVALID_JSON_TOKEN = 'token-list-invalid-json-token';
const TOKEN_LIST_INVALID_STRUCTURE_TOKEN = 'token-list-invalid-structure-token';
const TOKEN_LIST_EMPTY_TOKEN = 'token-list-empty-token';
const TOKEN_ABORT_DISCOVERY_TOKEN = 'token-abort-discovery-token';
const GROUP_PERMISSION_DENIED_TOKEN = 'group-permission-denied-token';
const OPENAI_MODELS_SHIELDED_TOKEN = 'session=openai-models-shielded-token';
const COOKIE_SHIELDED_TOKEN = Buffer.from(
  `1771864970|${Buffer.from('username=linuxdo_131936').toString('base64')}|sig`,
).toString('base64');
const COOKIE_GOB_USER_TOKEN = Buffer.from(
  `1772806887|${Buffer.from(
    '0d7f040102ff8000011001100000ff93ff80000506737472696e670c060004726f6c6503696e740402000206737472696e670c08000673746174757303696e740402000206737472696e670c07000567726f757006737472696e670c09000764656661756c7406737472696e670c040002696403696e74040500fd04683006737472696e670c0a0008757365726e616d6506737472696e670c09000773756974313539',
    'hex',
  ).toString('base64')}|sig`,
).toString('base64');
const ANYROUTER_CHALLENGE_HTML = readFileSync(
  new URL('./__fixtures__/anyrouter-challenge.html', import.meta.url),
  'utf8',
);
const ANYROUTER_CHALLENGE_ACW = '699dbedad126579b6bc0ebb91eaae8d7af3548b5';
const CLOUDFLARE_530_HTML = `
<!doctype html>
<html lang="en-US">
  <head>
    <title>Cloudflare Tunnel error | newapi.tanmw.top | Cloudflare</title>
  </head>
  <body>
    <h1><span>Error</span><span>1033</span></h1>
    <h2>Cloudflare Tunnel error</h2>
  </body>
</html>
`;

describe('NewApiAdapter', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let requests: RequestSnapshot[] = [];

  beforeEach(async () => {
    requests = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Connection', 'close');
      requests.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
      });

      if (req.url === '/v1/models') {
        if (
          typeof req.headers.authorization === 'string'
          && req.headers.authorization === `Bearer ${COOKIE_SESSION_TOKEN}`
          && typeof req.headers.cookie === 'string'
          && req.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: [
              { id: 'cookie-visible-model' },
            ],
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${OPENAI_MODELS_SHIELDED_TOKEN}`) {
          const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
          if (!cookieHeader.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
            });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (
            !cookieHeader.includes(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`)
            || !cookieHeader.includes(OPENAI_MODELS_SHIELDED_TOKEN)
          ) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'missing shield cookie context' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: [
              { id: 'claude-sonnet-4-5-20250929' },
              { id: 'claude-opus-4-6' },
            ],
          }));
          return;
        }

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid token' } }));
        return;
      }

      if (req.url === '/api/user/login' && req.method === 'POST') {
        let bodyRaw = '';
        req.on('data', (chunk) => {
          bodyRaw += chunk.toString();
        });
        req.on('end', () => {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(bodyRaw || '{}');
          } catch {}

          const isShieldLogin =
            payload.username === SHIELD_LOGIN_USERNAME &&
            payload.password === SHIELD_LOGIN_PASSWORD;
          const isCookieOnlyLogin =
            payload.username === COOKIE_ONLY_LOGIN_USERNAME &&
            payload.password === COOKIE_ONLY_LOGIN_PASSWORD;
          const isTwoFactorLogin =
            payload.username === TWO_FACTOR_LOGIN_USERNAME &&
            payload.password === TWO_FACTOR_LOGIN_PASSWORD;
          const isTurnstileLogin =
            payload.username === TURNSTILE_LOGIN_USERNAME &&
            payload.password === TURNSTILE_LOGIN_PASSWORD;
          const invalidIntegerLoginValue = typeof payload.username === 'string'
            ? INVALID_INTEGER_LOGIN_VALUES[payload.username]
            : undefined;
          const isInvalidIntegerLogin = invalidIntegerLoginValue !== undefined
            && payload.password === INVALID_INTEGER_LOGIN_PASSWORD;
          if (
            !isShieldLogin
            && !isCookieOnlyLogin
            && !isTwoFactorLogin
            && !isTurnstileLogin
            && !isInvalidIntegerLogin
          ) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'invalid credentials' }));
            return;
          }

          const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
          if (!cookieHeader.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
            });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }

          if (!cookieHeader.includes(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing shield cookie' }));
            return;
          }

          if (isCookieOnlyLogin) {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Set-Cookie': `session=${COOKIE_ONLY_LOGIN_SESSION}; Path=/; HttpOnly`,
            });
            res.end(JSON.stringify({
              success: true,
              data: { id: COOKIE_ONLY_LOGIN_USER_ID },
            }));
            return;
          }

          if (isTwoFactorLogin) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              data: { id: 33001, require_2fa: true },
            }));
            return;
          }

          if (isTurnstileLogin) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              message: 'Turnstile verification failed',
            }));
            return;
          }

          if (isInvalidIntegerLogin) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              data: { id: invalidIntegerLoginValue, token: SHIELD_LOGIN_TOKEN },
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: SHIELD_LOGIN_USER_ID, token: SHIELD_LOGIN_TOKEN },
          }));
        });
        return;
      }

      if (req.url === '/api/user/models') {
        if (req.headers['new-api-user'] !== '11494') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: ['gpt-4o', 'gpt-4.1'] }));
        return;
      }

      if (req.url === '/api/notice') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: 'Welcome to the site',
        }));
        return;
      }

      if (req.url?.startsWith('/api/token/')) {
        const authorization = typeof req.headers.authorization === 'string'
          ? req.headers.authorization
          : '';
        const cookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
        const hasCredential = (token: string) => (
          authorization === `Bearer ${token}` || cookie.includes(token)
        );

        if (hasCredential(TOKEN_LIST_PERMISSION_DENIED_TOKEN)) {
          const status = authorization ? 403 : 401;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: status === 403 ? 'token list forbidden by role' : 'cookie unauthorized',
          }));
          return;
        }
        if (hasCredential(TOKEN_LIST_401_TOKEN)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'token list unauthorized' }));
          return;
        }
        if (hasCredential(TOKEN_LIST_500_TOKEN)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'token list unavailable' }));
          return;
        }
        if (hasCredential(TOKEN_LIST_INVALID_JSON_TOKEN)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{not-json');
          return;
        }
        if (hasCredential(TOKEN_LIST_INVALID_STRUCTURE_TOKEN)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: { items: 'not-an-array' } }));
          return;
        }
        if (hasCredential(TOKEN_LIST_EMPTY_TOKEN)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: { items: [] } }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SHIELDED_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'shielded-cookie-key' }],
            },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SESSION_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_USER_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_X_USER_ID_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'cookie-api-key' }],
            },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_USER_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '8899') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'cookie-user-key' }],
            },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_X_USER_ID_TOKEN}`)) {
          if (req.headers['x-user-id'] !== '448') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing X-User-Id' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'cookie-x-user-id-key' }],
            },
          }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            items: [{ key: 'api-key-from-token-list' }],
          },
        }));
        return;
      }

      if (req.url === '/api/user/self') {
        if (req.headers.authorization === `Bearer ${TOKEN_ABORT_DISCOVERY_TOKEN}`) {
          setTimeout(() => {
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: { id: 11494 } }));
          }, 50);
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${BALANCE_SHIELD_FAILURE_TOKEN}`) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
          });
          res.end(ANYROUTER_CHALLENGE_HTML);
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${BALANCE_FAIL_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，access token 无效' }));
          return;
        }

        if (
          typeof req.headers.cookie === 'string' &&
          (
            req.headers.cookie.includes(`session=${BALANCE_SHIELD_FAILURE_TOKEN}`) ||
            req.headers.cookie.includes(`token=${BALANCE_SHIELD_FAILURE_TOKEN}`)
          )
        ) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }

        if (
          typeof req.headers.cookie === 'string' &&
          (
            req.headers.cookie.includes(`session=${BALANCE_FAIL_TOKEN}`) ||
            req.headers.cookie.includes(`token=${BALANCE_FAIL_TOKEN}`)
          )
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，access token 无效' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 131936, username: 'linuxdo_131936', quota: 3000000, used_quota: 1200000 },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === 'Bearer session-token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 11494, username: 'demo-user', quota: 1000000, used_quota: 1000 },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SESSION_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_USER_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_X_USER_ID_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 7788, username: 'cookie-user', quota: 2000000, used_quota: 500000 },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_USER_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '8899') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 8899, username: 'cookie-user-id-required', quota: 1500000, used_quota: 100000 },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_X_USER_ID_TOKEN}`)) {
          if (req.headers['x-user-id'] !== '448') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing X-User-Id' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 448, username: 'x-user-id-cookie-user', quota: 1500000, used_quota: 100000 },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_GOB_USER_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '144408') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 144408, username: 'suit159', quota: 50000000, used_quota: 0 },
          }));
          return;
        }

        if (
          typeof req.headers.cookie === 'string'
          && (
            req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_TOKEN}`)
            || req.headers.cookie.includes(`token=${CHECKIN_INVALID_URL_TOKEN}`)
          )
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'temporary self probe failure' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'New-Api-User permission denied' }));
          return;
        }

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
        return;
      }

      if (req.url === '/api/user/checkin') {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_CLOUDFLARE_530_TOKEN}`) {
          res.writeHead(530, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(CLOUDFLARE_530_HTML);
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_INVALID_URL_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_ALREADY_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '今天已经签到过啦' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_ALREADY_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SHIELDED_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'checked-in-ok' }));
          return;
        }
      }

      if (req.url === '/api/user/self/groups') {
        if (req.headers.authorization === `Bearer ${GROUP_PERMISSION_DENIED_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'access token 权限不足' }));
          return;
        }
        if (
          typeof req.headers.cookie === 'string'
          && req.headers.cookie.includes(GROUP_PERMISSION_DENIED_TOKEN)
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { default: { ratio: 1, desc: 'Default group' } },
          }));
          return;
        }

        if (req.headers.authorization === `Bearer ${COOKIE_GROUP_RATE_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Unauthorized, invalid access token' }));
          return;
        }
        if (req.headers.authorization === `Bearer ${MALFORMED_BEARER_GROUP_RATE_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{broken-json');
          return;
        }
        if (req.headers.authorization === `Bearer ${NON_AUTH_LOGIN_WORD_GROUP_RATE_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '登录方式配置不支持分组倍率' }));
          return;
        }
        if (req.headers.authorization === `Bearer ${NON_AUTH_EXPIRED_GROUP_RATE_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'subscription expired' }));
          return;
        }
        if (req.headers.authorization === `Bearer ${NON_SHIELD_HTML_GROUP_RATE_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><script>window.maintenance = true;</script><body>maintenance</body></html>');
          return;
        }
        if (
          typeof req.headers.cookie === 'string'
          && req.headers.cookie.includes(COOKIE_GROUP_RATE_TOKEN)
          && req.headers['new-api-user'] === String(SHIELD_LOGIN_USER_ID)
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: {
              default: { ratio: 1, desc: 'Default group' },
              vip: { ratio: 0.8, desc: 'VIP group' },
            },
          }));
          return;
        }
        if (
          typeof req.headers.cookie === 'string'
          && req.headers.cookie.includes(MALFORMED_BEARER_GROUP_RATE_TOKEN)
          && req.headers['new-api-user'] === String(SHIELD_LOGIN_USER_ID)
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { default: { ratio: 1, desc: 'Default group' } },
          }));
          return;
        }
        if (
          typeof req.headers.cookie === 'string'
          && req.headers.cookie.includes(NON_AUTH_LOGIN_WORD_GROUP_RATE_TOKEN)
          && req.headers['new-api-user'] === String(SHIELD_LOGIN_USER_ID)
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { default: { ratio: 1, desc: 'Default group' } },
          }));
          return;
        }
        if (
          typeof req.headers.cookie === 'string'
          && req.headers.cookie.includes(NON_AUTH_EXPIRED_GROUP_RATE_TOKEN)
          && req.headers['new-api-user'] === String(SHIELD_LOGIN_USER_ID)
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { default: { ratio: 1, desc: 'Default group' } },
          }));
          return;
        }
        if (
          typeof req.headers.cookie === 'string'
          && req.headers.cookie.includes(NON_SHIELD_HTML_GROUP_RATE_TOKEN)
          && req.headers['new-api-user'] === String(SHIELD_LOGIN_USER_ID)
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { default: { ratio: 1, desc: 'Default group' } },
          }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${GROUP_EXPIRED_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'access token expired' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === 'Bearer session-token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: { default: true, gemini: true } }));
          return;
        }
        if (
          req.headers.authorization === `Bearer ${GROUP_RATE_TOKEN}`
          && req.headers['new-api-user'] === String(SHIELD_LOGIN_USER_ID)
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: {
              default: { ratio: 1, desc: 'Default group' },
              vip: { ratio: 0.8, desc: 'VIP group' },
              auto: { ratio: '自动', desc: 'Automatic routing' },
            },
          }));
          return;
        }
        if (req.headers.authorization === `Bearer ${AUTO_ONLY_GROUP_RATE_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: {
              auto: { ratio: '自动', desc: 'Automatic routing' },
            },
          }));
          return;
        }
        if (
          req.headers.authorization === `Bearer ${MALFORMED_GROUP_RATE_TOKEN}`
          || (typeof req.headers.cookie === 'string'
            && req.headers.cookie.includes(MALFORMED_GROUP_RATE_TOKEN))
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: {
              default: { ratio: 1 },
              broken: { ratio: 'not-a-rate' },
            },
          }));
          return;
        }
        if (req.headers.authorization === `Bearer ${FAILED_GROUP_RATE_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        if (
          typeof req.headers.cookie === 'string'
          && req.headers.cookie.includes(FAILED_GROUP_RATE_TOKEN)
        ) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        if (req.headers.authorization === `Bearer ${AMBIGUOUS_EMPTY_GROUP_RATE_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        if (req.headers.authorization === `Bearer ${EXPLICIT_EMPTY_GROUP_RATE_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: {} }));
          return;
        }
      }

      if (req.url === '/api/user/sign_in') {
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_ALREADY_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  });

  it('falls back to session model endpoint when /v1/models rejects token', async () => {
    const adapter = new NewApiAdapter();
    const models = await adapter.getModels(baseUrl, 'session-token', 11494);

    expect(models).toEqual(['gpt-4o', 'gpt-4.1']);
    expect(requests.some((r) => r.url === '/v1/models')).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/models' && r.headers['new-api-user'] === '11494'),
    ).toBe(true);
  });

  it('reuses shield cookie retry when new-api /v1/models returns challenge html for cookie credentials', async () => {
    const adapter = new NewApiAdapter();
    const models = await adapter.getModels(baseUrl, OPENAI_MODELS_SHIELDED_TOKEN);

    expect(models).toEqual(['claude-sonnet-4-5-20250929', 'claude-opus-4-6']);
    expect(
      requests.some(
        (r) =>
          r.url === '/v1/models'
          && typeof r.headers.cookie === 'string'
          && r.headers.cookie.includes(OPENAI_MODELS_SHIELDED_TOKEN),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.url === '/v1/models'
          && typeof r.headers.cookie === 'string'
          && r.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`),
      ),
    ).toBe(true);
  });

  it('parses token list response with data.items[] shape', async () => {
    const adapter = new NewApiAdapter();
    const token = await adapter.getApiToken(baseUrl, 'session-token', 11494);

    expect(token).toBe('api-key-from-token-list');
  });

  it.each([
    [TOKEN_LIST_401_TOKEN, /HTTP 401/i],
    [TOKEN_LIST_500_TOKEN, /HTTP 500/i],
    [TOKEN_LIST_INVALID_JSON_TOKEN, /invalid token list response/i],
    [TOKEN_LIST_INVALID_STRUCTURE_TOKEN, /invalid token list response/i],
  ])('rejects failed or malformed token-list responses for %s', async (accessToken, expectedError) => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getApiTokens(baseUrl, accessToken, 11494)).rejects.toThrow(expectedError);
  });

  it('accepts an explicit successful empty token list', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getApiTokens(baseUrl, TOKEN_LIST_EMPTY_TOKEN, 11494)).resolves.toEqual([]);
  });

  it('preserves a bearer permission denial without trying cookie token-list fallback', async () => {
    const adapter = new NewApiAdapter();
    const requestStart = requests.length;

    await expect(adapter.getApiTokens(
      baseUrl,
      TOKEN_LIST_PERMISSION_DENIED_TOKEN,
      11494,
    )).rejects.toThrow(/HTTP 403.*forbidden by role/i);

    const tokenRequests = requests.slice(requestStart)
      .filter((request) => request.url.startsWith('/api/token/'));
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.headers.authorization)
      .toBe(`Bearer ${TOKEN_LIST_PERMISSION_DENIED_TOKEN}`);
  });

  it('aborts token user-id discovery before starting token-list fallbacks', async () => {
    const adapter = new NewApiAdapter();
    const requestStart = requests.length;
    const controller = new AbortController();
    const pending = adapter.getApiTokens(
      baseUrl,
      TOKEN_ABORT_DISCOVERY_TOKEN,
      undefined,
      controller.signal,
    );

    await vi.waitFor(() => expect(requests.some((request) => (
      request.url === '/api/user/self'
      && request.headers.authorization === `Bearer ${TOKEN_ABORT_DISCOVERY_TOKEN}`
    ))).toBe(true));
    controller.abort(new Error('cancel new-api token discovery'));

    await expect(pending).rejects.toThrow('cancel new-api token discovery');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(requests.slice(requestStart).some((request) => request.url.startsWith('/api/token/'))).toBe(false);
  });

  it('solves acw challenge for account-password login', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.login(baseUrl, SHIELD_LOGIN_USERNAME, SHIELD_LOGIN_PASSWORD);

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe(SHIELD_LOGIN_TOKEN);
    expect(result.platformUserId).toBe(SHIELD_LOGIN_USER_ID);
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/login' &&
          typeof r.headers.cookie === 'string' &&
          r.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/login' &&
          typeof r.headers.cookie === 'string' &&
          r.headers.cookie.includes(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`),
      ),
    ).toBe(true);
  });

  it('uses session cookie as access credential when login success has no token payload', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.login(baseUrl, COOKIE_ONLY_LOGIN_USERNAME, COOKIE_ONLY_LOGIN_PASSWORD);

    expect(result.success).toBe(true);
    expect(result.platformUserId).toBe(COOKIE_ONLY_LOGIN_USER_ID);
    expect(result.accessToken || '').toContain(`session=${COOKIE_ONLY_LOGIN_SESSION}`);
    expect(result.accessToken || '').toContain(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`);
    expect(result.accessToken || '').toContain(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`);
  });

  it('rejects account-password login when the upstream requires 2FA', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.login(baseUrl, TWO_FACTOR_LOGIN_USERNAME, TWO_FACTOR_LOGIN_PASSWORD);

    expect(result.success).toBe(false);
    expect(result.message).toContain('2FA');
  });

  it('returns an explicit failure when the upstream requires Turnstile', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.login(baseUrl, TURNSTILE_LOGIN_USERNAME, TURNSTILE_LOGIN_PASSWORD);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Turnstile');
  });

  it.each(Object.keys(INVALID_INTEGER_LOGIN_VALUES))(
    'does not accept malformed platform user id from login: %s',
    async (username) => {
      const adapter = new NewApiAdapter();
      const result = await adapter.login(baseUrl, username, INVALID_INTEGER_LOGIN_PASSWORD);

      expect(result).toMatchObject({
        success: true,
        accessToken: SHIELD_LOGIN_TOKEN,
      });
      expect(result).not.toHaveProperty('platformUserId');
    },
  );

  it('returns numeric account group rates and skips automatic groups', async () => {
    const adapter = new NewApiAdapter();

    const rates = await adapter.getGroupRates(baseUrl, GROUP_RATE_TOKEN, SHIELD_LOGIN_USER_ID);

    expect(rates).toEqual([
      {
        groupKey: 'default',
        groupName: 'default',
        description: 'Default group',
        ratio: 1,
      },
      {
        groupKey: 'vip',
        groupName: 'vip',
        description: 'VIP group',
        ratio: 0.8,
      },
    ]);
  });

  it('falls back to the login cookie when the bearer group-rate envelope reports an expired access token', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getGroupRates(
      baseUrl,
      COOKIE_GROUP_RATE_TOKEN,
      SHIELD_LOGIN_USER_ID,
    )).resolves.toEqual([
      {
        groupKey: 'default',
        groupName: 'default',
        description: 'Default group',
        ratio: 1,
      },
      {
        groupKey: 'vip',
        groupName: 'vip',
        description: 'VIP group',
        ratio: 0.8,
      },
    ]);
  });

  it('does not hide malformed bearer group-rate JSON behind a successful cookie fallback', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getGroupRates(
      baseUrl,
      MALFORMED_BEARER_GROUP_RATE_TOKEN,
      SHIELD_LOGIN_USER_ID,
    )).rejects.toThrow(/group rate response.*json/i);

    expect(requests.some((request) => (
      request.url === '/api/user/self/groups'
      && typeof request.headers.cookie === 'string'
      && request.headers.cookie.includes(MALFORMED_BEARER_GROUP_RATE_TOKEN)
    ))).toBe(false);
  });

  it('does not treat every group-rate error containing login wording as an expired session', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getGroupRates(
      baseUrl,
      NON_AUTH_LOGIN_WORD_GROUP_RATE_TOKEN,
      SHIELD_LOGIN_USER_ID,
    )).rejects.toThrow('登录方式配置不支持分组倍率');

    expect(requests.some((request) => (
      request.url === '/api/user/self/groups'
      && typeof request.headers.cookie === 'string'
      && request.headers.cookie.includes(NON_AUTH_LOGIN_WORD_GROUP_RATE_TOKEN)
    ))).toBe(false);
  });

  it('does not treat unrelated expired business state as an expired account session', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getGroupRates(
      baseUrl,
      NON_AUTH_EXPIRED_GROUP_RATE_TOKEN,
      SHIELD_LOGIN_USER_ID,
    )).rejects.toThrow('subscription expired');

    expect(requests.some((request) => (
      request.url === '/api/user/self/groups'
      && typeof request.headers.cookie === 'string'
      && request.headers.cookie.includes(NON_AUTH_EXPIRED_GROUP_RATE_TOKEN)
    ))).toBe(false);
  });

  it('does not rewrite or cookie-retry ordinary group permission denials as session expiry', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getGroupRates(
      baseUrl,
      GROUP_PERMISSION_DENIED_TOKEN,
      SHIELD_LOGIN_USER_ID,
    )).rejects.toThrow('access token 权限不足');

    expect(requests.some((request) => (
      request.url === '/api/user/self/groups'
      && typeof request.headers.cookie === 'string'
      && request.headers.cookie.includes(GROUP_PERMISSION_DENIED_TOKEN)
    ))).toBe(false);
  });

  it('does not treat ordinary html with a script tag as a shield challenge', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getGroupRates(
      baseUrl,
      NON_SHIELD_HTML_GROUP_RATE_TOKEN,
      SHIELD_LOGIN_USER_ID,
    )).rejects.toThrow(/group rate response.*json/i);

    expect(requests.some((request) => (
      request.url === '/api/user/self/groups'
      && typeof request.headers.cookie === 'string'
      && request.headers.cookie.includes(NON_SHIELD_HTML_GROUP_RATE_TOKEN)
    ))).toBe(false);
  });

  it('rejects a non-empty snapshot containing only automatic groups', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getGroupRates(
      baseUrl,
      AUTO_ONLY_GROUP_RATE_TOKEN,
      SHIELD_LOGIN_USER_ID,
    )).rejects.toThrow(/invalid group rate/i);
  });

  it('rejects malformed non-automatic account group rates', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getGroupRates(
      baseUrl,
      MALFORMED_GROUP_RATE_TOKEN,
      SHIELD_LOGIN_USER_ID,
    )).rejects.toThrow(/invalid group rate/i);
  });

  it('rejects non-success HTTP responses from every group-rate auth variant', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getGroupRates(
      baseUrl,
      FAILED_GROUP_RATE_TOKEN,
      SHIELD_LOGIN_USER_ID,
    )).rejects.toThrow(/HTTP 500/i);
  });

  it('rejects an ambiguous raw empty group-rate object', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getGroupRates(
      baseUrl,
      AMBIGUOUS_EMPTY_GROUP_RATE_TOKEN,
      SHIELD_LOGIN_USER_ID,
    )).rejects.toThrow(/invalid group rate/i);
  });

  it('accepts an explicit successful empty group-rate snapshot', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getGroupRates(
      baseUrl,
      EXPLICIT_EMPTY_GROUP_RATE_TOKEN,
      SHIELD_LOGIN_USER_ID,
    )).resolves.toEqual([]);
  });

  it('detects cookie session values as session cookies for new-api variants', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_SESSION_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('cookie-user');
    expect(result.apiToken).toBe('cookie-api-key');
    expect(
      requests.some((r) => r.url === '/api/user/self' && typeof r.headers.cookie === 'string' && r.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)),
    ).toBe(true);
  });

  it('does not classify new-api cookie sessions as api keys via cookie model discovery', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_SESSION_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('cookie-user');
    expect(result.apiToken).toBe('cookie-api-key');
    expect(
      requests.some((r) => r.url === '/v1/models' && typeof r.headers.authorization === 'string' && r.headers.authorization === `Bearer ${COOKIE_SESSION_TOKEN}`),
    ).toBe(true);
    expect(
      requests.some((r) => r.url === '/v1/models' && typeof r.headers.cookie === 'string' && r.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)),
    ).toBe(false);
  });

  it('auto-probes New-Api-User for cookie sessions when header is required', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_REQUIRES_USER_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('cookie-user-id-required');
    expect(result.apiToken).toBe('cookie-user-key');
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '8899'),
    ).toBe(true);
  });

  it('sends X-User-Id for cookie sessions when the site requires that New API variant', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_REQUIRES_X_USER_ID_TOKEN, 448);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('x-user-id-cookie-user');
    expect(result.apiToken).toBe('cookie-x-user-id-key');
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['x-user-id'] === '448'),
    ).toBe(true);
    expect(
      requests.some((r) => r.url?.startsWith('/api/token/') && r.headers['x-user-id'] === '448'),
    ).toBe(true);
  });

  it('solves acw challenge and probes user id from session payload', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_SHIELDED_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('linuxdo_131936');
    expect(typeof result.apiToken === 'string' && result.apiToken.length > 0).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/self' &&
          typeof r.headers.cookie === 'string' &&
          r.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`),
      ),
    ).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '131936'),
    ).toBe(true);
  });

  it('extracts gob-encoded user id from session cookie when reading balance', async () => {
    const adapter = new NewApiAdapter();
    const balance = await adapter.getBalance(baseUrl, COOKIE_GOB_USER_TOKEN);

    expect(balance.balance).toBe(100);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '144408'),
    ).toBe(true);
  });

  it('recovers from mismatched provided user id by probing gob-encoded session payload', async () => {
    const adapter = new NewApiAdapter();
    const balance = await adapter.getBalance(baseUrl, COOKIE_GOB_USER_TOKEN, 159);

    expect(balance.balance).toBe(100);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '159'),
    ).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '144408'),
    ).toBe(true);
  });

  it('uses shielded cookie flow for balance and checkin', async () => {
    const adapter = new NewApiAdapter();
    const balance = await adapter.getBalance(baseUrl, COOKIE_SHIELDED_TOKEN);
    const checkin = await adapter.checkin(baseUrl, COOKIE_SHIELDED_TOKEN);

    expect(balance).toEqual({
      quota: 8.4,
      used: 2.4,
      balance: 6,
    });
    expect(checkin.success).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/checkin' && r.headers['new-api-user'] === '131936'),
    ).toBe(true);
  });

  it('preserves upstream balance failure message for UI feedback', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getBalance(baseUrl, BALANCE_FAIL_TOKEN)).rejects.toThrow('access token');
  });

  it('prefers post-challenge cookie failure over raw html parse error when reading balance', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getBalance(baseUrl, BALANCE_SHIELD_FAILURE_TOKEN)).rejects
      .toThrow('无权进行此操作，未登录且未提供 access token');
  });

  it('preserves nested checkin error message instead of generic fallback', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_INVALID_URL_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid URL');
  });

  it('prefers cookie session auth failure over invalid-url fallback when cookie session is expired', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN, 131936);

    expect(result.success).toBe(false);
    expect(result.message).toContain('access token');
    expect(result.message).not.toContain('Invalid URL');
  });

  it('does not replace an endpoint failure with a user-id permission denial from self-probe', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN, 131936);

    expect(result.success).toBe(false);
    expect(result.message).not.toContain('permission denied');
  });

  it('summarizes cloudflare tunnel HTML failures to concise checkin error', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_CLOUDFLARE_530_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toBe('HTTP 530: Cloudflare Tunnel error (Error 1033)');
  });

  it('preserves already-checked-in message instead of overriding with cookie fallback error', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_ALREADY_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toBe('今天已经签到过啦');
  });

  it('returns clean groups from data object without envelope keys', async () => {
    const adapter = new NewApiAdapter();
    const groups = await adapter.getUserGroups(baseUrl, 'session-token', 11494);

    expect(groups).toEqual(['default', 'gemini']);
    expect(groups).not.toContain('success');
    expect(groups).not.toContain('message');
  });

  it('throws expired-session error when group endpoint reports invalid access token', async () => {
    const adapter = new NewApiAdapter();
    await expect(adapter.getUserGroups(baseUrl, GROUP_EXPIRED_TOKEN, 11494)).rejects.toThrow('账号会话可能已过期');
  });

  it('sends all compatibility user-id headers when userId is known', async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
    const receivedHeaders: Record<string, string> = {};
    server = createServer((req, res) => {
      for (const name of ['new-api-user', 'veloera-user', 'voapi-user', 'user-id', 'rix-api-user', 'neo-api-user']) {
        const val = req.headers[name];
        if (val) receivedHeaders[name] = String(val);
      }
      if (req.url === '/api/user/self') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { id: 42, username: 'test', quota: 500000, used_quota: 0 } }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const adapter = new NewApiAdapter();
    const fakeJwt = `header.${Buffer.from(JSON.stringify({ id: 42 })).toString('base64url')}.sig`;
    await adapter.getBalance(baseUrl, fakeJwt, 42);

    expect(receivedHeaders['new-api-user']).toBe('42');
    expect(receivedHeaders['veloera-user']).toBe('42');
    expect(receivedHeaders['voapi-user']).toBe('42');
    expect(receivedHeaders['user-id']).toBe('42');
    expect(receivedHeaders['rix-api-user']).toBe('42');
    expect(receivedHeaders['neo-api-user']).toBe('42');
  });

  it('normalizes the global site notice from /api/notice', async () => {
    const adapter = new NewApiAdapter();
    const rows = await adapter.getSiteAnnouncements(baseUrl, 'session-token');

    expect(rows).toEqual([
      {
        sourceKey: `notice:${createHash('sha1').update('Welcome to the site').digest('hex')}`,
        title: 'Site notice',
        content: 'Welcome to the site',
        level: 'info',
        sourceUrl: '/api/notice',
        rawPayload: { success: true, data: 'Welcome to the site' },
      },
    ]);
  });
});
