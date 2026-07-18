import type { PlatformAdapter, PlatformDetectionContext } from './base.js';
import { NewApiAdapter } from './newApi.js';
import { OneApiAdapter } from './oneApi.js';
import { VeloeraAdapter } from './veloera.js';
import { OneHubAdapter } from './oneHub.js';
import { DoneHubAdapter } from './doneHub.js';
import { Sub2ApiAdapter } from './sub2api.js';
import { OpenAiAdapter } from './openai.js';
import { ClaudeAdapter } from './claude.js';
import { GeminiAdapter } from './gemini.js';
import { CliProxyApiAdapter } from './cliproxyapi.js';
import { detectPlatformByTitle } from './titleHint.js';
import { detectPlatformByUrlHint, normalizePlatformAlias } from '../../../shared/platformIdentity.js';

const adapters: PlatformAdapter[] = [
  // Specific forks before generic adapters for better auto-detection.
  new OpenAiAdapter(),
  new ClaudeAdapter(),
  new GeminiAdapter(),
  new CliProxyApiAdapter(),
  new DoneHubAdapter(),
  new OneHubAdapter(),
  new VeloeraAdapter(),
  new NewApiAdapter(),
  new Sub2ApiAdapter(),
  new OneApiAdapter(),
];

function normalizePlatform(platform: string): string {
  return normalizePlatformAlias(platform);
}

export function getAdapter(platform: string): PlatformAdapter | undefined {
  const normalized = normalizePlatform(platform);
  return adapters.find((a) => a.platformName === normalized);
}

const titleFirstPlatforms = new Set<string>([
  'done-hub',
  'one-hub',
  'veloera',
  'sub2api',
]);

const PLATFORM_DETECTION_TIMEOUT_MS = 10_000;

export async function detectPlatform(
  url: string,
  context?: PlatformDetectionContext,
): Promise<PlatformAdapter | undefined> {
  const urlHint = detectPlatformByUrlHint(url);
  if (urlHint) {
    return getAdapter(urlHint);
  }

  const deadlineSignal = AbortSignal.timeout(PLATFORM_DETECTION_TIMEOUT_MS);
  const boundedContext: PlatformDetectionContext = {
    ...context,
    signal: context?.signal
      ? AbortSignal.any([context.signal, deadlineSignal])
      : deadlineSignal,
  };

  const titleHint = await detectPlatformByTitle(url, boundedContext);
  if (titleHint && titleFirstPlatforms.has(titleHint)) {
    return getAdapter(titleHint);
  }

  for (const adapter of adapters) {
    if (boundedContext.signal?.aborted) return undefined;
    if (await adapter.detect(url, boundedContext)) return adapter;
  }

  if (titleHint) {
    return getAdapter(titleHint);
  }

  return undefined;
}
