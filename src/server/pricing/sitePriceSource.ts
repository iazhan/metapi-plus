import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getPlatformUserIdFromExtraConfig } from '../services/accountExtraConfig.js';
import { getAdapter } from '../services/platforms/index.js';
import type { PlatformAdapter } from '../services/platforms/base.js';
import {
  sitePriceInputSchema,
  type PricingCredential,
  type SitePriceInput,
} from './contracts.js';

export type SitePriceSourceFailureKind = 'not_found' | 'disabled' | 'unsupported' | 'no_credentials' | 'invalid_response' | 'upstream';

export class SitePriceSourceError extends Error {
  constructor(
    public readonly kind: SitePriceSourceFailureKind,
    public readonly siteId: number,
  ) {
    super(kind === 'upstream' ? 'site price fetch failed' : `site pricing ${kind}`);
    this.name = 'SitePriceSourceError';
  }
}

export interface SitePriceSourceDependencies {
  getAdapter?: (platform: string) => PlatformAdapter | undefined;
  now?: () => Date;
}

function addCredential(
  target: PricingCredential[],
  seen: Set<string>,
  credential: PricingCredential,
): void {
  const value = credential.value.trim();
  if (!value || seen.has(value)) return;
  seen.add(value);
  target.push({ ...credential, value });
}

async function listPricingCredentials(siteId: number): Promise<PricingCredential[]> {
  const accounts = await db.select().from(schema.accounts)
    .where(and(eq(schema.accounts.siteId, siteId), eq(schema.accounts.status, 'active')))
    .orderBy(asc(schema.accounts.id))
    .all();
  const credentials: PricingCredential[] = [];
  const seen = new Set<string>();

  for (const account of accounts) {
    const platformUserId = getPlatformUserIdFromExtraConfig(account.extraConfig);
    addCredential(credentials, seen, {
      kind: 'session',
      value: account.accessToken,
      ...(platformUserId ? { platformUserId } : {}),
    });
    if (account.apiToken) {
      addCredential(credentials, seen, { kind: 'api_key', value: account.apiToken });
    }
    const tokens = await db.select().from(schema.accountTokens)
      .where(and(
        eq(schema.accountTokens.accountId, account.id),
        eq(schema.accountTokens.enabled, true),
      ))
      .orderBy(asc(schema.accountTokens.id))
      .all();
    for (const token of tokens) {
      addCredential(credentials, seen, { kind: 'api_key', value: token.token });
    }
  }
  return credentials;
}

/** Fetches a complete, validated site quote set without exposing credential-specific failures. */
export async function fetchSitePrices(
  siteId: number,
  signal?: AbortSignal,
  deps: SitePriceSourceDependencies = {},
): Promise<SitePriceInput[]> {
  signal?.throwIfAborted();
  const site = await db.select().from(schema.sites)
    .where(eq(schema.sites.id, siteId))
    .get();
  if (!site) throw new SitePriceSourceError('not_found', siteId);
  if (site.status !== 'active') throw new SitePriceSourceError('disabled', siteId);

  const adapter = (deps.getAdapter ?? getAdapter)(site.platform);
  if (!adapter?.getPricing) throw new SitePriceSourceError('unsupported', siteId);

  const credentials = await listPricingCredentials(siteId);
  const seen = new Set(credentials.map((credential) => credential.value));
  if (site.apiKey) addCredential(credentials, seen, { kind: 'api_key', value: site.apiKey });
  if (credentials.length === 0) throw new SitePriceSourceError('no_credentials', siteId);

  for (const credential of credentials) {
    signal?.throwIfAborted();
    try {
      const quotes = await adapter.getPricing(site.url.replace(/\/+$/, ''), credential, signal);
      const fetchedAt = (deps.now ?? (() => new Date()))().toISOString();
      const parsed = sitePriceInputSchema.array().safeParse(
        quotes.map((quote) => ({ ...quote, fetchedAt })),
      );
      if (!parsed.success) throw new SitePriceSourceError('invalid_response', siteId);
      return parsed.data;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SitePriceSourceError && error.kind === 'invalid_response') throw error;
    }
  }
  throw new SitePriceSourceError('upstream', siteId);
}
