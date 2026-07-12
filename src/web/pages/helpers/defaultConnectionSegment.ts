import { normalizePlatformAlias } from '../../../shared/platformIdentity.js';

export type InitialConnectionSegment = 'session' | 'apikey';

const SESSION_FIRST_PLATFORMS = new Set([
  'new-api',
  'one-api',
  'veloera',
  'one-hub',
  'done-hub',
  'sub2api',
]);

const API_KEY_FIRST_PLATFORMS = new Set([
  'openai',
  'claude',
  'gemini',
  'cliproxyapi',
]);

export function resolveInitialConnectionSegment(platform?: string | null): InitialConnectionSegment {
  const normalized = normalizePlatformAlias(platform);
  if (SESSION_FIRST_PLATFORMS.has(normalized)) return 'session';
  if (API_KEY_FIRST_PLATFORMS.has(normalized)) return 'apikey';
  return 'apikey';
}
