import type { SchemaContract } from './schemaContract.js';

export const OAUTH_RETIREMENT_MIGRATION_TAG = '0030_remove_oauth_native_connections';

export type OauthRetirementDialect = 'sqlite' | 'mysql' | 'postgres';

const REMOVED_TABLES = ['oauth_route_unit_members', 'oauth_route_units'] as const;
const REMOVED_COLUMNS = [
  'accounts.oauth_provider',
  'accounts.oauth_account_key',
  'accounts.oauth_project_id',
  'route_channels.oauth_route_unit_id',
] as const;
const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export function isChatGptCodexSite(platform: unknown, url: unknown): boolean {
  if (String(platform || '').trim().toLowerCase() !== 'codex') return false;
  try {
    const parsed = new URL(String(url || '').trim());
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'chatgpt.com'
      && (path === '/backend-api/codex' || path.startsWith('/backend-api/codex/'));
  } catch {
    return false;
  }
}

function buildChatGptCodexSqlCondition(trimFunction: 'trim' | 'btrim'): string {
  return `(lower(${trimFunction}(platform)) = 'codex' AND (
        lower(${trimFunction}(url)) = '${CHATGPT_CODEX_BASE_URL}'
        OR lower(${trimFunction}(url)) LIKE '${CHATGPT_CODEX_BASE_URL}/%'
        OR lower(${trimFunction}(url)) LIKE '${CHATGPT_CODEX_BASE_URL}?%'
        OR lower(${trimFunction}(url)) LIKE '${CHATGPT_CODEX_BASE_URL}#%'
      ))`;
}

export function resolveRetiredSiteAction(
  platform: unknown,
  url: unknown,
): 'delete' | 'reclassify-openai' | 'keep' {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  if (normalizedPlatform === 'gemini-cli' || normalizedPlatform === 'antigravity') return 'delete';
  if (normalizedPlatform === 'codex') {
    return isChatGptCodexSite(normalizedPlatform, url) ? 'delete' : 'reclassify-openai';
  }
  return 'keep';
}

export function isOauthRetirementRequired(contract: SchemaContract): boolean {
  if (REMOVED_TABLES.some((tableName) => !!contract.tables[tableName])) return true;
  return REMOVED_COLUMNS.some((removalKey) => {
    const [tableName, columnName] = removalKey.split('.');
    return !!tableName && !!columnName && !!contract.tables[tableName]?.columns[columnName];
  });
}

function buildSqliteStatements(): readonly string[] {
  return [
    'DROP TABLE IF EXISTS temp._oauth_retired_channels',
    'DROP TABLE IF EXISTS temp._oauth_retired_accounts',
    'DROP TABLE IF EXISTS temp._oauth_retired_sites',
    'CREATE TEMP TABLE _oauth_retired_sites (id INTEGER PRIMARY KEY)',
    `INSERT INTO _oauth_retired_sites (id)
      SELECT id FROM sites
      WHERE lower(trim(platform)) IN ('gemini-cli', 'antigravity')
         OR ${buildChatGptCodexSqlCondition('trim')}`,
    `UPDATE sites SET platform = 'openai'
      WHERE lower(trim(platform)) = 'codex'
        AND id NOT IN (SELECT id FROM _oauth_retired_sites)`,
    'CREATE TEMP TABLE _oauth_retired_accounts (id INTEGER PRIMARY KEY)',
    `INSERT INTO _oauth_retired_accounts (id)
      SELECT id FROM accounts
      WHERE site_id IN (SELECT id FROM _oauth_retired_sites)
         OR nullif(trim(oauth_provider), '') IS NOT NULL
         OR nullif(trim(oauth_account_key), '') IS NOT NULL
         OR nullif(trim(oauth_project_id), '') IS NOT NULL
         OR json_extract(extra_config, '$.oauth.provider') IS NOT NULL`,
    'CREATE TEMP TABLE _oauth_retired_channels (id INTEGER PRIMARY KEY)',
    `INSERT INTO _oauth_retired_channels (id)
      SELECT id FROM route_channels
      WHERE account_id IN (SELECT id FROM _oauth_retired_accounts)
         OR oauth_route_unit_id IS NOT NULL`,
    `UPDATE downstream_api_keys
      SET site_weight_multipliers = (
        SELECT coalesce(json_group_object(key, value), '{}')
        FROM json_each(downstream_api_keys.site_weight_multipliers)
        WHERE cast(key AS INTEGER) NOT IN (SELECT id FROM _oauth_retired_sites)
      )
      WHERE site_weight_multipliers IS NOT NULL AND trim(site_weight_multipliers) <> ''`,
    `UPDATE downstream_api_keys
      SET excluded_site_ids = (
        SELECT coalesce(json_group_array(value), '[]')
        FROM json_each(downstream_api_keys.excluded_site_ids)
        WHERE cast(value AS INTEGER) NOT IN (SELECT id FROM _oauth_retired_sites)
      )
      WHERE excluded_site_ids IS NOT NULL AND trim(excluded_site_ids) <> ''`,
    `UPDATE downstream_api_keys
      SET excluded_credential_refs = (
        SELECT coalesce(json_group_array(json(value)), '[]')
        FROM json_each(downstream_api_keys.excluded_credential_refs)
        WHERE cast(json_extract(value, '$.siteId') AS INTEGER) NOT IN (SELECT id FROM _oauth_retired_sites)
          AND cast(json_extract(value, '$.accountId') AS INTEGER) NOT IN (SELECT id FROM _oauth_retired_accounts)
      )
      WHERE excluded_credential_refs IS NOT NULL AND trim(excluded_credential_refs) <> ''`,
    `UPDATE proxy_logs SET account_id = NULL
      WHERE account_id IN (SELECT id FROM _oauth_retired_accounts)`,
    `UPDATE proxy_logs SET channel_id = NULL
      WHERE channel_id IN (SELECT id FROM _oauth_retired_channels)`,
    `UPDATE proxy_video_tasks SET account_id = NULL
      WHERE account_id IN (SELECT id FROM _oauth_retired_accounts)`,
    `UPDATE proxy_video_tasks SET channel_id = NULL
      WHERE channel_id IN (SELECT id FROM _oauth_retired_channels)`,
    'DELETE FROM route_channels WHERE id IN (SELECT id FROM _oauth_retired_channels)',
    'DELETE FROM accounts WHERE id IN (SELECT id FROM _oauth_retired_accounts)',
    'DELETE FROM sites WHERE id IN (SELECT id FROM _oauth_retired_sites)',
    'DROP TABLE temp._oauth_retired_channels',
    'DROP TABLE temp._oauth_retired_accounts',
    'DROP TABLE temp._oauth_retired_sites',
  ] as const;
}

function buildPostgresStatements(): readonly string[] {
  return [
    'CREATE TEMP TABLE _oauth_retired_sites (id bigint PRIMARY KEY) ON COMMIT DROP',
    `INSERT INTO _oauth_retired_sites (id)
      SELECT id FROM sites
      WHERE lower(btrim(platform)) IN ('gemini-cli', 'antigravity')
         OR ${buildChatGptCodexSqlCondition('btrim')}`,
    `UPDATE sites SET platform = 'openai'
      WHERE lower(btrim(platform)) = 'codex'
        AND id NOT IN (SELECT id FROM _oauth_retired_sites)`,
    'CREATE TEMP TABLE _oauth_retired_accounts (id bigint PRIMARY KEY) ON COMMIT DROP',
    `INSERT INTO _oauth_retired_accounts (id)
      SELECT id FROM accounts
      WHERE site_id IN (SELECT id FROM _oauth_retired_sites)
         OR nullif(btrim(oauth_provider), '') IS NOT NULL
         OR nullif(btrim(oauth_account_key), '') IS NOT NULL
         OR nullif(btrim(oauth_project_id), '') IS NOT NULL
         OR (extra_config::jsonb #>> '{oauth,provider}') IS NOT NULL`,
    'CREATE TEMP TABLE _oauth_retired_channels (id bigint PRIMARY KEY) ON COMMIT DROP',
    `INSERT INTO _oauth_retired_channels (id)
      SELECT id FROM route_channels
      WHERE account_id IN (SELECT id FROM _oauth_retired_accounts)
         OR oauth_route_unit_id IS NOT NULL`,
    `UPDATE downstream_api_keys d SET site_weight_multipliers = coalesce((
        SELECT jsonb_object_agg(entry.key, entry.value)::text
        FROM jsonb_each(d.site_weight_multipliers::jsonb) entry
        WHERE entry.key::bigint NOT IN (SELECT id FROM _oauth_retired_sites)
      ), '{}')
      WHERE d.site_weight_multipliers IS NOT NULL AND btrim(d.site_weight_multipliers) <> ''`,
    `UPDATE downstream_api_keys d SET excluded_site_ids = coalesce((
        SELECT jsonb_agg(entry.value)::text
        FROM jsonb_array_elements(d.excluded_site_ids::jsonb) entry(value)
        WHERE (entry.value #>> '{}')::bigint NOT IN (SELECT id FROM _oauth_retired_sites)
      ), '[]')
      WHERE d.excluded_site_ids IS NOT NULL AND btrim(d.excluded_site_ids) <> ''`,
    `UPDATE downstream_api_keys d SET excluded_credential_refs = coalesce((
        SELECT jsonb_agg(entry.value)::text
        FROM jsonb_array_elements(d.excluded_credential_refs::jsonb) entry(value)
        WHERE (entry.value ->> 'siteId')::bigint NOT IN (SELECT id FROM _oauth_retired_sites)
          AND (entry.value ->> 'accountId')::bigint NOT IN (SELECT id FROM _oauth_retired_accounts)
      ), '[]')
      WHERE d.excluded_credential_refs IS NOT NULL AND btrim(d.excluded_credential_refs) <> ''`,
    'UPDATE proxy_logs SET account_id = NULL WHERE account_id IN (SELECT id FROM _oauth_retired_accounts)',
    'UPDATE proxy_logs SET channel_id = NULL WHERE channel_id IN (SELECT id FROM _oauth_retired_channels)',
    'UPDATE proxy_video_tasks SET account_id = NULL WHERE account_id IN (SELECT id FROM _oauth_retired_accounts)',
    'UPDATE proxy_video_tasks SET channel_id = NULL WHERE channel_id IN (SELECT id FROM _oauth_retired_channels)',
    'DELETE FROM route_channels WHERE id IN (SELECT id FROM _oauth_retired_channels)',
    'DELETE FROM accounts WHERE id IN (SELECT id FROM _oauth_retired_accounts)',
    'DELETE FROM sites WHERE id IN (SELECT id FROM _oauth_retired_sites)',
  ] as const;
}

function buildMysqlStatements(): readonly string[] {
  return [
    'DROP TEMPORARY TABLE IF EXISTS _oauth_retired_channels',
    'DROP TEMPORARY TABLE IF EXISTS _oauth_retired_accounts',
    'DROP TEMPORARY TABLE IF EXISTS _oauth_retired_sites',
    'CREATE TEMPORARY TABLE _oauth_retired_sites (id bigint PRIMARY KEY)',
    `INSERT INTO _oauth_retired_sites (id)
      SELECT id FROM sites
      WHERE lower(trim(platform)) IN ('gemini-cli', 'antigravity')
         OR ${buildChatGptCodexSqlCondition('trim')}`,
    `UPDATE sites SET platform = 'openai'
      WHERE lower(trim(platform)) = 'codex'
        AND id NOT IN (SELECT id FROM _oauth_retired_sites)`,
    'CREATE TEMPORARY TABLE _oauth_retired_accounts (id bigint PRIMARY KEY)',
    `INSERT INTO _oauth_retired_accounts (id)
      SELECT id FROM accounts
      WHERE site_id IN (SELECT id FROM _oauth_retired_sites)
         OR nullif(trim(oauth_provider), '') IS NOT NULL
         OR nullif(trim(oauth_account_key), '') IS NOT NULL
         OR nullif(trim(oauth_project_id), '') IS NOT NULL
         OR json_unquote(json_extract(extra_config, '$.oauth.provider')) IS NOT NULL`,
    'CREATE TEMPORARY TABLE _oauth_retired_channels (id bigint PRIMARY KEY)',
    `INSERT INTO _oauth_retired_channels (id)
      SELECT id FROM route_channels
      WHERE account_id IN (SELECT id FROM _oauth_retired_accounts)
         OR oauth_route_unit_id IS NOT NULL`,
    `UPDATE downstream_api_keys d LEFT JOIN (
        SELECT d2.id, json_objectagg(j.k, json_extract(d2.site_weight_multipliers, concat('$."', replace(j.k, '"', '\\"'), '"'))) AS cleaned
        FROM downstream_api_keys d2
        JOIN json_table(json_keys(d2.site_weight_multipliers), '$[*]' COLUMNS (k varchar(255) PATH '$')) j
        LEFT JOIN _oauth_retired_sites retired ON retired.id = cast(j.k AS unsigned)
        WHERE retired.id IS NULL
        GROUP BY d2.id
      ) clean ON clean.id = d.id
      SET d.site_weight_multipliers = coalesce(clean.cleaned, json_object())
      WHERE d.site_weight_multipliers IS NOT NULL AND trim(d.site_weight_multipliers) <> ''`,
    `UPDATE downstream_api_keys d LEFT JOIN (
        SELECT d2.id, json_arrayagg(j.site_id) AS cleaned
        FROM downstream_api_keys d2
        JOIN json_table(d2.excluded_site_ids, '$[*]' COLUMNS (site_id bigint PATH '$')) j
        LEFT JOIN _oauth_retired_sites retired ON retired.id = j.site_id
        WHERE retired.id IS NULL
        GROUP BY d2.id
      ) clean ON clean.id = d.id
      SET d.excluded_site_ids = coalesce(clean.cleaned, json_array())
      WHERE d.excluded_site_ids IS NOT NULL AND trim(d.excluded_site_ids) <> ''`,
    `UPDATE downstream_api_keys d LEFT JOIN (
        SELECT d2.id, json_arrayagg(json_extract(d2.excluded_credential_refs, concat('$[', j.ordinality - 1, ']'))) AS cleaned
        FROM downstream_api_keys d2
        JOIN json_table(d2.excluded_credential_refs, '$[*]' COLUMNS (
          ordinality FOR ORDINALITY,
          site_id bigint PATH '$.siteId',
          account_id bigint PATH '$.accountId'
        )) j
        LEFT JOIN _oauth_retired_sites retired_site ON retired_site.id = j.site_id
        LEFT JOIN _oauth_retired_accounts retired_account ON retired_account.id = j.account_id
        WHERE retired_site.id IS NULL AND retired_account.id IS NULL
        GROUP BY d2.id
      ) clean ON clean.id = d.id
      SET d.excluded_credential_refs = coalesce(clean.cleaned, json_array())
      WHERE d.excluded_credential_refs IS NOT NULL AND trim(d.excluded_credential_refs) <> ''`,
    'UPDATE proxy_logs SET account_id = NULL WHERE account_id IN (SELECT id FROM _oauth_retired_accounts)',
    'UPDATE proxy_logs SET channel_id = NULL WHERE channel_id IN (SELECT id FROM _oauth_retired_channels)',
    'UPDATE proxy_video_tasks SET account_id = NULL WHERE account_id IN (SELECT id FROM _oauth_retired_accounts)',
    'UPDATE proxy_video_tasks SET channel_id = NULL WHERE channel_id IN (SELECT id FROM _oauth_retired_channels)',
    'DELETE FROM route_channels WHERE id IN (SELECT id FROM _oauth_retired_channels)',
    'DELETE FROM accounts WHERE id IN (SELECT id FROM _oauth_retired_accounts)',
    'DELETE FROM sites WHERE id IN (SELECT id FROM _oauth_retired_sites)',
    'DROP TEMPORARY TABLE _oauth_retired_channels',
    'DROP TEMPORARY TABLE _oauth_retired_accounts',
    'DROP TEMPORARY TABLE _oauth_retired_sites',
  ] as const;
}

export function buildOauthRetirementStatements(
  dialect: OauthRetirementDialect,
): readonly string[] {
  if (dialect === 'sqlite') return buildSqliteStatements();
  if (dialect === 'postgres') return buildPostgresStatements();
  return buildMysqlStatements();
}

export function renderSqliteOauthRetirementMigration(): string {
  return `${buildSqliteStatements().join(';\n--> statement-breakpoint\n')};\n`;
}
