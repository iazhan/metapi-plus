import { createHash } from 'node:crypto';
import type { RequestInit as UndiciRequestInit } from 'undici';
import {
  withSiteRecordProxyRequestInit,
  withSiteProxyRequestInit,
  type SiteProxyConfigLike,
} from '../siteProxy.js';
import type { PlatformPriceQuote, PricingCredential } from '../../pricing/contracts.js';

export interface CheckinResult {
  success: boolean;
  message: string;
  reward?: string;
}

export interface SubscriptionPlanSummary {
  id?: number;
  groupId?: number;
  groupName?: string;
  status?: string;
  expiresAt?: string;
  dailyUsedUsd?: number;
  dailyLimitUsd?: number;
  weeklyUsedUsd?: number;
  weeklyLimitUsd?: number;
  monthlyUsedUsd?: number;
  monthlyLimitUsd?: number;
}

export interface SubscriptionSummary {
  activeCount: number;
  totalUsedUsd: number;
  subscriptions: SubscriptionPlanSummary[];
}

export interface BalanceInfo {
  balance: number;
  used: number;
  quota: number;
  todayIncome?: number;
  todayQuotaConsumption?: number;
  subscriptionSummary?: SubscriptionSummary;
}

export interface LoginResult {
  success: boolean;
  accessToken?: string;
  username?: string;
  platformUserId?: number;
  refreshToken?: string;
  expiresAt?: number;
  message?: string;
}

export interface GroupRateInfo {
  groupKey: string;
  groupName: string;
  ratio: number;
  description?: string | null;
}

function parseSafeInteger(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) ? raw : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseSafePositiveInteger(raw: unknown): number | undefined {
  const parsed = parseSafeInteger(raw);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

export function parseSafeNonNegativeInteger(raw: unknown): number | undefined {
  const parsed = parseSafeInteger(raw);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

export class PlatformHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`HTTP ${status}: ${responseBody}`);
    this.name = 'PlatformHttpError';
  }
}

export interface UserInfo {
  username: string;
  displayName?: string;
  email?: string;
  role?: number;
}

export interface TokenVerifyResult {
  tokenType: 'session' | 'apikey' | 'unknown';
  userInfo?: UserInfo | null;
  balance?: BalanceInfo | null;
  apiToken?: string | null;
  models?: string[];
}

export interface ApiTokenInfo {
  name: string;
  key: string;
  enabled?: boolean;
  tokenGroup?: string | null;
}

export interface SiteAnnouncement {
  sourceKey: string;
  title: string;
  content: string;
  level: 'info' | 'warning' | 'error';
  sourceUrl?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  upstreamCreatedAt?: string | null;
  upstreamUpdatedAt?: string | null;
  rawPayload?: unknown;
}

export interface CreateApiTokenOptions {
  name?: string;
  group?: string;
  unlimitedQuota?: boolean;
  remainQuota?: number;
  expiredTime?: number;
  allowIps?: string;
  modelLimitsEnabled?: boolean;
  modelLimits?: string;
}

export type PlatformDetectionContext = {
  siteProxy?: SiteProxyConfigLike | null;
  signal?: AbortSignal;
};

/**
 * 将平台探测上下文应用到单次请求。未提供显式站点代理时保持直连，避免探测意外继承已保存站点配置。
 */
export function withPlatformDetectionRequestInit(
  context: PlatformDetectionContext | undefined,
  options?: UndiciRequestInit,
): UndiciRequestInit {
  const requestOptions: UndiciRequestInit = {
    ...(options || {}),
    signal: options?.signal ?? context?.signal,
  };
  return context?.siteProxy
    ? withSiteRecordProxyRequestInit(context.siteProxy, requestOptions)
    : requestOptions;
}

export interface PlatformAdapter {
  readonly platformName: string;
  detect(url: string, context?: PlatformDetectionContext): Promise<boolean>;
  login(baseUrl: string, username: string, password: string, signal?: AbortSignal): Promise<LoginResult>;
  getUserInfo(baseUrl: string, accessToken: string, platformUserId?: number): Promise<UserInfo | null>;
  verifyToken(baseUrl: string, token: string, platformUserId?: number): Promise<TokenVerifyResult>;
  checkin(baseUrl: string, accessToken: string, platformUserId?: number): Promise<CheckinResult>;
  getBalance(baseUrl: string, accessToken: string, platformUserId?: number): Promise<BalanceInfo>;
  getModels(baseUrl: string, token: string, platformUserId?: number): Promise<string[]>;
  getApiToken(baseUrl: string, accessToken: string, platformUserId?: number, signal?: AbortSignal): Promise<string | null>;
  getApiTokens(baseUrl: string, accessToken: string, platformUserId?: number, signal?: AbortSignal): Promise<ApiTokenInfo[]>;
  getSiteAnnouncements(baseUrl: string, accessToken: string, platformUserId?: number): Promise<SiteAnnouncement[]>;
  getUserGroups(baseUrl: string, accessToken: string, platformUserId?: number): Promise<string[]>;
  getGroupRates?(baseUrl: string, accessToken: string, platformUserId?: number, signal?: AbortSignal): Promise<GroupRateInfo[]>;
  getPricing?(baseUrl: string, credential: PricingCredential, signal?: AbortSignal): Promise<PlatformPriceQuote[]>;
  createApiToken(baseUrl: string, accessToken: string, platformUserId?: number, options?: CreateApiTokenOptions): Promise<boolean>;
  deleteApiToken(baseUrl: string, accessToken: string, tokenKey: string, platformUserId?: number): Promise<boolean>;
}

export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly platformName: string;

  abstract detect(url: string, context?: PlatformDetectionContext): Promise<boolean>;
  abstract checkin(baseUrl: string, accessToken: string): Promise<CheckinResult>;
  abstract getBalance(baseUrl: string, accessToken: string): Promise<BalanceInfo>;
  abstract getModels(baseUrl: string, token: string, platformUserId?: number): Promise<string[]>;

  async verifyToken(baseUrl: string, token: string, _platformUserId?: number): Promise<TokenVerifyResult> {
    // 1. Try as session/access token first (for management APIs)
    const userInfo = await this.getUserInfo(baseUrl, token);
    if (userInfo) {
      let balance: BalanceInfo | null = null;
      try { balance = await this.getBalance(baseUrl, token); } catch {}
      let apiToken: string | null = null;
      try { apiToken = await this.getApiToken(baseUrl, token); } catch {}
      return { tokenType: 'session', userInfo, balance, apiToken };
    }

    // 2. Try as API key (for /v1/models)
    try {
      const models = await this.getModels(baseUrl, token);
      if (models && models.length > 0) {
        return { tokenType: 'apikey', models };
      }
    } catch {}

    return { tokenType: 'unknown' };
  }

  async getUserInfo(baseUrl: string, accessToken: string): Promise<UserInfo | null> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user/self`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res?.success && res?.data) {
        return {
          username: res.data.username || res.data.display_name || '',
          displayName: res.data.display_name,
          email: res.data.email,
          role: res.data.role,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async login(baseUrl: string, username: string, password: string, signal?: AbortSignal): Promise<LoginResult> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user/login`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
        signal,
      });
      if (res?.success && res?.data) {
        const rawPlatformUserId = typeof res.data === 'object'
          ? res.data.id ?? res.data.user_id ?? res.data.userId
          : undefined;
        const parsedPlatformUserId = parseSafePositiveInteger(rawPlatformUserId);
        return {
          success: true,
          accessToken: typeof res.data === 'string' ? res.data : res.data.token || res.data.access_token,
          username,
          ...(parsedPlatformUserId !== undefined
            ? { platformUserId: parsedPlatformUserId }
            : {}),
        };
      }
      return { success: false, message: res?.message || '登录失败' };
    } catch (err: any) {
      signal?.throwIfAborted();
      return { success: false, message: err.message || '登录请求失败' };
    }
  }

  async getApiToken(
    _baseUrl: string,
    _accessToken: string,
    _platformUserId?: number,
    _signal?: AbortSignal,
  ): Promise<string | null> {
    return null;
  }

  async getApiTokens(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
    signal?: AbortSignal,
  ): Promise<ApiTokenInfo[]> {
    const token = await this.getApiToken(baseUrl, accessToken, platformUserId, signal);
    if (!token) return [];
    return [{ name: 'default', key: token, enabled: true, tokenGroup: 'default' }];
  }

  async getSiteAnnouncements(
    _baseUrl: string,
    _accessToken: string,
    _platformUserId?: number,
  ): Promise<SiteAnnouncement[]> {
    return [];
  }

  async createApiToken(
    _baseUrl: string,
    _accessToken: string,
    _platformUserId?: number,
    _options?: CreateApiTokenOptions,
  ): Promise<boolean> {
    return false;
  }

  async getUserGroups(
    _baseUrl: string,
    _accessToken: string,
    _platformUserId?: number,
  ): Promise<string[]> {
    return ['default'];
  }

  async deleteApiToken(
    _baseUrl: string,
    _accessToken: string,
    _tokenKey: string,
    _platformUserId?: number,
  ): Promise<boolean> {
    return false;
  }

  protected async fetchJson<T>(
    url: string,
    options?: UndiciRequestInit,
    detectionContext?: PlatformDetectionContext,
  ): Promise<T> {
    const { fetch } = await import('undici');
    const requestOptions: UndiciRequestInit = {
      ...options,
      body: options?.body ?? undefined,
      signal: options?.signal ?? detectionContext?.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    };
    const proxiedRequestOptions = detectionContext !== undefined
      ? withPlatformDetectionRequestInit(detectionContext, requestOptions)
      : await withSiteProxyRequestInit(url, requestOptions);
    const res = await fetch(url, proxiedRequestOptions);
    if (!res.ok) {
      throw new PlatformHttpError(res.status, await res.text());
    }
    return res.json() as Promise<T>;
  }

  /** 使用统一探测上下文读取 JSON；缺省探测上下文明确表示直连。 */
  protected fetchDetectionJson<T>(
    url: string,
    context?: PlatformDetectionContext,
    options?: UndiciRequestInit,
  ): Promise<T> {
    return this.fetchJson<T>(url, options, context ?? {});
  }

  protected buildNoticeSourceKey(content: string): string {
    const normalized = (content || '').trim();
    return `notice:${createHash('sha1').update(normalized).digest('hex')}`;
  }
}
