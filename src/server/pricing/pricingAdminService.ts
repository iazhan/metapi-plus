import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { getCredentialModeFromExtraConfig } from '../services/accountExtraConfig.js';
import type {
  PricingProfileInput,
  SiteModelPriceRuleInput,
} from './contracts.js';
import { resolveEffectivePrice } from './effectivePriceResolver.js';
import {
  deleteAccountGroupRateRule,
  deleteSiteModelPriceRule,
  getSitePricingProfile,
  listOfficialModelPrices,
  listPricingRefreshStates,
  listSiteModelPriceRules,
  listSiteModelPrices,
  upsertAccountGroupRateRule,
  upsertSiteModelPriceRule,
  upsertSitePricingProfile,
} from './pricingRepository.js';
import {
  getPriceRefreshTimeZone,
  triggerPriceRefresh,
  updatePriceRefreshScheduler,
} from './priceRefreshScheduler.js';

async function siteExists(siteId: number): Promise<boolean> {
  return !!await db.select({ id: schema.sites.id }).from(schema.sites)
    .where(eq(schema.sites.id, siteId)).get();
}

async function accountExists(accountId: number): Promise<boolean> {
  return !!await db.select({ id: schema.accounts.id }).from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).get();
}

export async function getPricingSettings() {
  return {
    enabled: config.priceRefreshEnabled,
    cronExpr: config.priceRefreshCron,
    timeZone: getPriceRefreshTimeZone(),
    refreshStates: await listPricingRefreshStates(),
  };
}

export async function updatePricingSettings(input: { enabled: boolean; cronExpr: string }) {
  await db.transaction(async (tx) => {
    await upsertSetting('price_refresh_enabled', input.enabled, tx as typeof db);
    await upsertSetting('price_refresh_cron', input.cronExpr, tx as typeof db);
  });
  config.priceRefreshEnabled = input.enabled;
  config.priceRefreshCron = input.cronExpr;
  await updatePriceRefreshScheduler(input);
  return { success: true, ...input, timeZone: getPriceRefreshTimeZone() };
}

export async function refreshPricing() {
  return { success: true, result: await triggerPriceRefresh() };
}

export async function getSitePricing(siteId: number) {
  if (!await siteExists(siteId)) return null;
  const [profile, prices, rules, catalog, refreshStates] = await Promise.all([
    getSitePricingProfile(siteId),
    listSiteModelPrices(siteId),
    listSiteModelPriceRules(siteId),
    listOfficialModelPrices(),
    listPricingRefreshStates(),
  ]);
  const referenceAccount = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.siteId, siteId)).limit(1).get();
  const credentialKind = referenceAccount && getCredentialModeFromExtraConfig(referenceAccount.extraConfig) === 'apikey'
    ? 'api_key' as const
    : 'session' as const;
  const referenceToken = referenceAccount && credentialKind === 'session'
    ? await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, referenceAccount.id)).limit(1).get()
    : null;
  const effectiveModels = referenceAccount
    ? await Promise.all(prices.map((price) => resolveEffectivePrice({
      siteId,
      accountId: referenceAccount.id,
      tokenGroup: referenceToken?.tokenGroup ?? null,
      credentialKind,
      upstreamModelId: price.upstreamModelId,
    })))
    : [];
  return {
    siteId,
    profile,
    models: prices,
    rules,
    catalog,
    referenceAccountId: referenceAccount?.id ?? null,
    effectiveModels,
    refreshState: refreshStates.find((row) => row.scopeType === 'site' && row.scopeId === siteId) ?? null,
  };
}

export async function saveSitePricingProfile(siteId: number, input: PricingProfileInput): Promise<boolean> {
  if (!await siteExists(siteId)) return false;
  await upsertSitePricingProfile(siteId, input);
  return true;
}

export async function saveSiteModelPriceRule(
  siteId: number,
  upstreamModelId: string,
  input: SiteModelPriceRuleInput,
): Promise<boolean> {
  if (!await siteExists(siteId)) return false;
  await upsertSiteModelPriceRule(siteId, upstreamModelId, input);
  return true;
}

export async function removeSiteModelPriceRule(
  siteId: number,
  upstreamModelId: string,
): Promise<boolean | null> {
  if (!await siteExists(siteId)) return null;
  return deleteSiteModelPriceRule(siteId, upstreamModelId);
}

export async function saveAccountGroupRateRule(
  accountId: number,
  groupKey: string,
  ratioOverride: number,
): Promise<boolean> {
  if (!await accountExists(accountId)) return false;
  await upsertAccountGroupRateRule(accountId, groupKey, ratioOverride);
  return true;
}

export async function removeAccountGroupRateRule(
  accountId: number,
  groupKey: string,
): Promise<boolean | null> {
  if (!await accountExists(accountId)) return null;
  return deleteAccountGroupRateRule(accountId, groupKey);
}
