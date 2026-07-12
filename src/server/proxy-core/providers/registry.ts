import { claudeProviderProfile } from './claudeProviderProfile.js';
import type { ProviderProfile } from './types.js';

const providerProfilesByPlatform: Record<string, ProviderProfile> = {
  claude: claudeProviderProfile,
};

export function resolveProviderProfile(sitePlatform?: string | null): ProviderProfile | null {
  const normalized = typeof sitePlatform === 'string' ? sitePlatform.trim().toLowerCase() : '';
  return providerProfilesByPlatform[normalized] ?? null;
}
