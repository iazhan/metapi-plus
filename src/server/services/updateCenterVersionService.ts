import { fetch, type RequestInit as UndiciRequestInit } from 'undici';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type StableSemVer = {
  raw: string;
  normalized: string;
  major: number;
  minor: number;
  patch: number;
};

export type UpdateCenterVersionSource = 'github-release' | 'container-tag';
export type LegacyUpdateCenterVersionSource = UpdateCenterVersionSource | 'docker-hub-tag';

export type UpdateCenterVersionCandidate = {
  source: UpdateCenterVersionSource;
  rawVersion: string;
  normalizedVersion: string;
  url: string | null;
  tagName?: string | null;
  digest?: string | null;
  displayVersion?: string | null;
  publishedAt?: string | null;
};

export type GitHubReleaseRecord = {
  tag_name?: string | null;
  html_url?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  name?: string | null;
};

export type ContainerTagRecord = {
  name?: string | null;
  tag_last_pushed?: string | null;
  last_updated?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  digest?: string | null;
  url?: string | null;
};

export type GhcrPackageVersionRecord = {
  name?: string | null;
  html_url?: string | null;
  package_html_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  metadata?: {
    container?: {
      tags?: string[];
      digest?: string | null;
    } | null;
  } | null;
};

export type ContainerTagCandidates = {
  primary: UpdateCenterVersionCandidate | null;
  recentNonStable: UpdateCenterVersionCandidate[];
};

const STABLE_SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/i;
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/iazhan/metapi-plus/releases';
const GHCR_PACKAGE_VERSIONS_URL = 'https://api.github.com/users/iazhan/packages/container/metapi-plus/versions?per_page=100';
const UPDATE_CENTER_VERSION_FETCH_TIMEOUT_MS = 5_000;
const PREFERRED_CONTAINER_TAG_ALIASES = ['latest', 'main'] as const;
const MAX_RECENT_NON_STABLE_CONTAINER_TAGS = 5;

async function fetchJsonWithTimeout(url: string, init: UndiciRequestInit, timeoutLabel: string): Promise<unknown> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, UPDATE_CENTER_VERSION_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${timeoutLabel} failed with HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`${timeoutLabel} timeout (${Math.round(UPDATE_CENTER_VERSION_FETCH_TIMEOUT_MS / 1000)}s)`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
}

export function parseStableSemVer(input: string | null | undefined): StableSemVer | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const match = raw.match(STABLE_SEMVER_PATTERN);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (![major, minor, patch].every(Number.isFinite)) return null;
  return {
    raw,
    normalized: `${major}.${minor}.${patch}`,
    major,
    minor,
    patch,
  };
}

export function compareStableSemVer(a: StableSemVer, b: StableSemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function selectLatestStableGitHubRelease(
  releases: GitHubReleaseRecord[],
): UpdateCenterVersionCandidate | null {
  let selected: { semver: StableSemVer; release: GitHubReleaseRecord } | null = null;

  for (const release of releases) {
    if (release?.draft || release?.prerelease) continue;
    const semver = parseStableSemVer(release?.tag_name);
    if (!semver) continue;
    if (!selected || compareStableSemVer(semver, selected.semver) > 0) {
      selected = { semver, release };
    }
  }

  if (!selected) return null;

  return {
    source: 'github-release',
    rawVersion: selected.release.tag_name || selected.semver.raw,
    normalizedVersion: selected.semver.normalized,
    url: selected.release.html_url || null,
    tagName: selected.release.tag_name || selected.semver.raw,
    displayVersion: selected.semver.normalized,
    publishedAt: selected.release.published_at || null,
  };
}

function normalizeContainerTagRecord(input: string | ContainerTagRecord): ContainerTagRecord {
  if (typeof input === 'string') {
    return {
      name: input,
    };
  }
  return input;
}

function normalizeContainerTagName(input: string | null | undefined): string {
  return String(input || '').trim();
}

function isPreferredContainerAlias(input: string | null | undefined): boolean {
  const tag = normalizeContainerTagName(input);
  return PREFERRED_CONTAINER_TAG_ALIASES.includes(tag as typeof PREFERRED_CONTAINER_TAG_ALIASES[number]);
}

function isStableContainerTag(input: string | null | undefined): boolean {
  const tag = normalizeContainerTagName(input);
  if (!tag) return false;
  return isPreferredContainerAlias(tag) || !!parseStableSemVer(tag);
}

function normalizeDockerDigest(input: string | null | undefined): string | null {
  const digest = String(input || '').trim();
  return /^sha256:[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : null;
}

function getContainerTagPublishedAt(record: ContainerTagRecord): string | null {
  const value = String(record.tag_last_pushed || record.last_updated || record.updated_at || record.created_at || '').trim();
  return value || null;
}

function getContainerTagPublishedTimestamp(record: ContainerTagRecord): number {
  const publishedAt = getContainerTagPublishedAt(record);
  if (!publishedAt) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(publishedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function getRecentNonStableContainerPriority(input: string | null | undefined): number {
  const tag = normalizeContainerTagName(input).toLowerCase();
  if (!tag) return 99;
  if (tag === 'dev') return 0;
  if (tag.startsWith('dev-')) return 1;
  if (tag.startsWith('sha-')) return 2;
  return 3;
}

function toShortDigest(digest: string | null | undefined): string | null {
  if (!digest) return null;
  return digest.slice(0, 'sha256:'.length + 12);
}

function buildContainerVersionCandidate(
  record: ContainerTagRecord,
  normalizedVersion: string,
): UpdateCenterVersionCandidate | null {
  const rawVersion = String(record.name || '').trim();
  if (!rawVersion) return null;
  const digest = normalizeDockerDigest(record.digest);
  return {
    source: 'container-tag',
    rawVersion,
    normalizedVersion,
    url: record.url || null,
    tagName: rawVersion,
    digest,
    displayVersion: digest ? `${rawVersion} @ ${toShortDigest(digest)}` : rawVersion,
    publishedAt: getContainerTagPublishedAt(record),
  };
}

export function selectLatestContainerTag(tags: Array<string | ContainerTagRecord>): UpdateCenterVersionCandidate | null {
  const records = tags
    .map((tag) => normalizeContainerTagRecord(tag))
    .filter((record) => String(record.name || '').trim());

  for (const alias of PREFERRED_CONTAINER_TAG_ALIASES) {
    const record = records.find((entry) => String(entry.name || '').trim() === alias);
    if (!record) continue;
    const candidate = buildContainerVersionCandidate(record, alias);
    if (candidate) return candidate;
  }

  let selected: { record: ContainerTagRecord; semver: StableSemVer } | null = null;

  for (const record of records) {
    const semver = parseStableSemVer(record.name);
    if (!semver) continue;
    if (!selected || compareStableSemVer(semver, selected.semver) > 0) {
      selected = { record, semver };
    }
  }

  if (!selected) return null;

  return buildContainerVersionCandidate(selected.record, selected.semver.normalized);
}

export function selectRecentNonStableContainerTags(
  tags: Array<string | ContainerTagRecord>,
  limit = MAX_RECENT_NON_STABLE_CONTAINER_TAGS,
): UpdateCenterVersionCandidate[] {
  const records = tags
    .map((tag) => normalizeContainerTagRecord(tag))
    .filter((record) => normalizeContainerTagName(record.name))
    .filter((record) => !isStableContainerTag(record.name));

  const deduped = new Map<string, ContainerTagRecord>();
  for (const record of records) {
    const tagName = normalizeContainerTagName(record.name);
    const previous = deduped.get(tagName);
    if (!previous || getContainerTagPublishedTimestamp(record) > getContainerTagPublishedTimestamp(previous)) {
      deduped.set(tagName, record);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => {
      const priorityDelta = getRecentNonStableContainerPriority(a.name) - getRecentNonStableContainerPriority(b.name);
      if (priorityDelta !== 0) return priorityDelta;
      const publishedDelta = getContainerTagPublishedTimestamp(b) - getContainerTagPublishedTimestamp(a);
      if (publishedDelta !== 0) return publishedDelta;
      return normalizeContainerTagName(a.name).localeCompare(normalizeContainerTagName(b.name));
    })
    .slice(0, Math.max(0, limit))
    .map((record) => buildContainerVersionCandidate(record, normalizeContainerTagName(record.name)))
    .filter((candidate): candidate is UpdateCenterVersionCandidate => !!candidate);
}

export function selectContainerTagCandidates(tags: Array<string | ContainerTagRecord>): ContainerTagCandidates {
  return {
    primary: selectLatestContainerTag(tags),
    recentNonStable: selectRecentNonStableContainerTags(tags),
  };
}

export const selectLatestDockerHubTag = selectLatestContainerTag;
export const selectRecentNonStableDockerHubTags = selectRecentNonStableContainerTags;
export const selectDockerHubTagCandidates = selectContainerTagCandidates;

function expandGhcrPackageVersions(versions: GhcrPackageVersionRecord[]): ContainerTagRecord[] {
  const records: ContainerTagRecord[] = [];
  for (const version of versions) {
    const tags = Array.isArray(version.metadata?.container?.tags)
      ? version.metadata.container.tags
      : [];
    for (const tag of tags) {
      const name = normalizeContainerTagName(tag);
      if (!name) continue;
      records.push({
        name,
        digest: version.metadata?.container?.digest || null,
        created_at: version.created_at || null,
        updated_at: version.updated_at || null,
        url: version.package_html_url || version.html_url || null,
      });
    }
  }
  return records;
}

export function resolvePreferredDeploySource(input: {
  defaultSource: UpdateCenterVersionSource;
  githubRelease: UpdateCenterVersionCandidate | null;
  dockerHubTag: UpdateCenterVersionCandidate | null;
}): UpdateCenterVersionCandidate | null {
  if (input.defaultSource === 'github-release') {
    return input.githubRelease || input.dockerHubTag;
  }
  return input.dockerHubTag || input.githubRelease;
}

export async function fetchLatestStableGitHubRelease(): Promise<UpdateCenterVersionCandidate | null> {
  const releases = await fetchJsonWithTimeout(GITHUB_RELEASES_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'metapi-update-center/1.0',
    },
  }, 'GitHub releases lookup') as GitHubReleaseRecord[];
  return selectLatestStableGitHubRelease(Array.isArray(releases) ? releases : []);
}

export async function fetchLatestContainerTag(): Promise<UpdateCenterVersionCandidate | null> {
  return (await fetchContainerTagCandidates()).primary;
}

export async function fetchContainerTagCandidates(): Promise<ContainerTagCandidates> {
  const payload = await fetchJsonWithTimeout(GHCR_PACKAGE_VERSIONS_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'metapi-update-center/1.0',
    },
  }, 'GHCR container tag lookup') as GhcrPackageVersionRecord[];
  return selectContainerTagCandidates(Array.isArray(payload) ? expandGhcrPackageVersions(payload) : []);
}

export const fetchLatestDockerHubTag = fetchLatestContainerTag;
export const fetchDockerHubTagCandidates = fetchContainerTagCandidates;

export function getCurrentRuntimeVersion(): string {
  try {
    const packageJsonPath = resolve(process.cwd(), 'package.json');
    const payload = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    const version = String(payload?.version || '').trim();
    return version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
