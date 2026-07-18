import { stripTrailingSlashes } from '../urlNormalization.js';
import {
  withPlatformDetectionRequestInit,
  type PlatformDetectionContext,
} from './base.js';

export type TitleHintPlatform =
  | 'done-hub'
  | 'one-hub'
  | 'veloera'
  | 'sub2api'
  | 'new-api'
  | 'one-api';

type TitleRule = {
  platform: TitleHintPlatform;
  regex: RegExp;
};

type TitleProbeResult = {
  platform?: TitleHintPlatform;
  timedOut: boolean;
};

const TITLE_PROBE_TIMEOUT_MS = 5_000;

const TITLE_RULES: TitleRule[] = [
  { platform: 'new-api', regex: /\bany\s*router\b/i },
  { platform: 'done-hub', regex: /\bdone[-_ ]?hub\b/i },
  { platform: 'one-hub', regex: /\bone[-_ ]?hub\b/i },
  { platform: 'veloera', regex: /\bveloera\b/i },
  { platform: 'sub2api', regex: /\bsub2api\b/i },
  { platform: 'new-api', regex: /\bnew[-_ ]?api\b/i },
  { platform: 'new-api', regex: /\bvo[-_ ]?api\b/i },
  { platform: 'new-api', regex: /\bsuper[-_ ]?api\b/i },
  { platform: 'new-api', regex: /\brix[-_ ]?api\b/i },
  { platform: 'new-api', regex: /\bneo[-_ ]?api\b/i },
  { platform: 'new-api', regex: /wong\s*(?:\u516c\u76ca\u7ad9)/i },
  { platform: 'one-api', regex: /\bone[-_ ]?api\b/i },
];

function normalizeBaseUrl(url: string): string {
  const trimmed = (url || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return stripTrailingSlashes(trimmed);
  }
}

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return '';
  return match[1].replace(/\s+/g, ' ').trim();
}

async function detectPlatformByTitleOnce(
  base: string,
  context?: PlatformDetectionContext,
): Promise<TitleProbeResult> {
  const timeoutSignal = AbortSignal.timeout(TITLE_PROBE_TIMEOUT_MS);
  const signal = context?.signal
    ? AbortSignal.any([context.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const { fetch } = await import('undici');
    const requestInit = {
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal,
    };
    const res = await fetch(
      `${base}/`,
      withPlatformDetectionRequestInit(context, requestInit),
    );
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      return { timedOut: false };
    }

    const title = extractHtmlTitle(await res.text());
    if (!title) return { timedOut: false };

    for (const rule of TITLE_RULES) {
      if (rule.regex.test(title)) return { platform: rule.platform, timedOut: false };
    }
    return { timedOut: false };
  } catch {
    return {
      timedOut: timeoutSignal.aborted && !context?.signal?.aborted,
    };
  }
}

export async function detectPlatformByTitle(
  url: string,
  context?: PlatformDetectionContext,
): Promise<TitleHintPlatform | undefined> {
  const base = normalizeBaseUrl(url);
  if (!base) return undefined;

  const first = await detectPlatformByTitleOnce(base, context);
  if (first.platform) return first.platform;
  if (first.timedOut) return undefined;
  if (context?.signal?.aborted) return undefined;

  // Under heavy parallel test load, local title probes can occasionally race
  // with just-started ephemeral HTTP servers. Retry once before giving up.
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 50);
    context?.signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
  if (context?.signal?.aborted) return undefined;
  const second = await detectPlatformByTitleOnce(base, context);
  return second.platform;
}
