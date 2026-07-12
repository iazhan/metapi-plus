DROP TABLE IF EXISTS temp._oauth_retired_channels;
--> statement-breakpoint
DROP TABLE IF EXISTS temp._oauth_retired_accounts;
--> statement-breakpoint
DROP TABLE IF EXISTS temp._oauth_retired_sites;
--> statement-breakpoint
CREATE TEMP TABLE _oauth_retired_sites (id INTEGER PRIMARY KEY);
--> statement-breakpoint
INSERT INTO _oauth_retired_sites (id)
      SELECT id FROM sites
      WHERE lower(trim(platform)) IN ('gemini-cli', 'antigravity')
         OR (lower(trim(platform)) = 'codex' AND (
        lower(trim(url)) = 'https://chatgpt.com/backend-api/codex'
        OR lower(trim(url)) LIKE 'https://chatgpt.com/backend-api/codex/%'
        OR lower(trim(url)) LIKE 'https://chatgpt.com/backend-api/codex?%'
        OR lower(trim(url)) LIKE 'https://chatgpt.com/backend-api/codex#%'
      ));
--> statement-breakpoint
UPDATE sites SET platform = 'openai'
      WHERE lower(trim(platform)) = 'codex'
        AND id NOT IN (SELECT id FROM _oauth_retired_sites);
--> statement-breakpoint
CREATE TEMP TABLE _oauth_retired_accounts (id INTEGER PRIMARY KEY);
--> statement-breakpoint
INSERT INTO _oauth_retired_accounts (id)
      SELECT id FROM accounts
      WHERE site_id IN (SELECT id FROM _oauth_retired_sites)
         OR nullif(trim(oauth_provider), '') IS NOT NULL
         OR nullif(trim(oauth_account_key), '') IS NOT NULL
         OR nullif(trim(oauth_project_id), '') IS NOT NULL
         OR json_extract(extra_config, '$.oauth.provider') IS NOT NULL;
--> statement-breakpoint
CREATE TEMP TABLE _oauth_retired_channels (id INTEGER PRIMARY KEY);
--> statement-breakpoint
INSERT INTO _oauth_retired_channels (id)
      SELECT id FROM route_channels
      WHERE account_id IN (SELECT id FROM _oauth_retired_accounts)
         OR oauth_route_unit_id IS NOT NULL;
--> statement-breakpoint
UPDATE downstream_api_keys
      SET site_weight_multipliers = (
        SELECT coalesce(json_group_object(key, value), '{}')
        FROM json_each(downstream_api_keys.site_weight_multipliers)
        WHERE cast(key AS INTEGER) NOT IN (SELECT id FROM _oauth_retired_sites)
      )
      WHERE site_weight_multipliers IS NOT NULL AND trim(site_weight_multipliers) <> '';
--> statement-breakpoint
UPDATE downstream_api_keys
      SET excluded_site_ids = (
        SELECT coalesce(json_group_array(value), '[]')
        FROM json_each(downstream_api_keys.excluded_site_ids)
        WHERE cast(value AS INTEGER) NOT IN (SELECT id FROM _oauth_retired_sites)
      )
      WHERE excluded_site_ids IS NOT NULL AND trim(excluded_site_ids) <> '';
--> statement-breakpoint
UPDATE downstream_api_keys
      SET excluded_credential_refs = (
        SELECT coalesce(json_group_array(json(value)), '[]')
        FROM json_each(downstream_api_keys.excluded_credential_refs)
        WHERE cast(json_extract(value, '$.siteId') AS INTEGER) NOT IN (SELECT id FROM _oauth_retired_sites)
          AND cast(json_extract(value, '$.accountId') AS INTEGER) NOT IN (SELECT id FROM _oauth_retired_accounts)
      )
      WHERE excluded_credential_refs IS NOT NULL AND trim(excluded_credential_refs) <> '';
--> statement-breakpoint
UPDATE proxy_logs SET account_id = NULL
      WHERE account_id IN (SELECT id FROM _oauth_retired_accounts);
--> statement-breakpoint
UPDATE proxy_logs SET channel_id = NULL
      WHERE channel_id IN (SELECT id FROM _oauth_retired_channels);
--> statement-breakpoint
UPDATE proxy_video_tasks SET account_id = NULL
      WHERE account_id IN (SELECT id FROM _oauth_retired_accounts);
--> statement-breakpoint
UPDATE proxy_video_tasks SET channel_id = NULL
      WHERE channel_id IN (SELECT id FROM _oauth_retired_channels);
--> statement-breakpoint
DELETE FROM route_channels WHERE id IN (SELECT id FROM _oauth_retired_channels);
--> statement-breakpoint
DELETE FROM accounts WHERE id IN (SELECT id FROM _oauth_retired_accounts);
--> statement-breakpoint
DELETE FROM sites WHERE id IN (SELECT id FROM _oauth_retired_sites);
--> statement-breakpoint
DROP TABLE temp._oauth_retired_channels;
--> statement-breakpoint
DROP TABLE temp._oauth_retired_accounts;
--> statement-breakpoint
DROP TABLE temp._oauth_retired_sites;
--> statement-breakpoint
DROP TABLE `oauth_route_unit_members`;--> statement-breakpoint
DROP TABLE `oauth_route_units`;--> statement-breakpoint
DROP INDEX `accounts_oauth_provider_idx`;--> statement-breakpoint
DROP INDEX `accounts_oauth_identity_idx`;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `oauth_provider`;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `oauth_account_key`;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `oauth_project_id`;--> statement-breakpoint
DROP INDEX `route_channels_oauth_route_unit_id_idx`;--> statement-breakpoint
ALTER TABLE `route_channels` DROP COLUMN `oauth_route_unit_id`;
