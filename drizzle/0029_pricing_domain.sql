CREATE TABLE `account_group_rate_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`group_key` text NOT NULL,
	`ratio_override` real NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_group_rate_rules_ratio_non_negative" CHECK("account_group_rate_rules"."ratio_override" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_group_rate_rules_account_group_unique` ON `account_group_rate_rules` (`account_id`,`group_key`);--> statement-breakpoint
CREATE INDEX `account_group_rate_rules_account_id_idx` ON `account_group_rate_rules` (`account_id`);--> statement-breakpoint
CREATE TABLE `official_model_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`display_name` text NOT NULL,
	`input_per_million_usd` real,
	`output_per_million_usd` real,
	`cache_read_per_million_usd` real,
	`cache_write_per_million_usd` real,
	`reasoning_per_million_usd` real,
	`input_audio_per_million_usd` real,
	`output_audio_per_million_usd` real,
	`tiers_json` text,
	`source_updated_at` text,
	`fetched_at` text NOT NULL,
	CONSTRAINT "official_model_prices_non_negative" CHECK(("official_model_prices"."input_per_million_usd" is null or "official_model_prices"."input_per_million_usd" >= 0)
      and ("official_model_prices"."output_per_million_usd" is null or "official_model_prices"."output_per_million_usd" >= 0)
      and ("official_model_prices"."cache_read_per_million_usd" is null or "official_model_prices"."cache_read_per_million_usd" >= 0)
      and ("official_model_prices"."cache_write_per_million_usd" is null or "official_model_prices"."cache_write_per_million_usd" >= 0)
      and ("official_model_prices"."reasoning_per_million_usd" is null or "official_model_prices"."reasoning_per_million_usd" >= 0)
      and ("official_model_prices"."input_audio_per_million_usd" is null or "official_model_prices"."input_audio_per_million_usd" >= 0)
      and ("official_model_prices"."output_audio_per_million_usd" is null or "official_model_prices"."output_audio_per_million_usd" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `official_model_prices_provider_model_unique` ON `official_model_prices` (`provider_id`,`model_id`);--> statement-breakpoint
CREATE INDEX `official_model_prices_model_id_idx` ON `official_model_prices` (`model_id`);--> statement-breakpoint
CREATE TABLE `pricing_refresh_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` integer DEFAULT 0 NOT NULL,
	`last_success_at` text,
	`last_failure_at` text,
	`last_failure_kind` text,
	`failure_active` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	CONSTRAINT "pricing_refresh_states_scope_valid" CHECK("pricing_refresh_states"."scope_type" in ('official', 'site'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pricing_refresh_states_scope_unique` ON `pricing_refresh_states` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE TABLE `site_model_price_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`upstream_model_id` text NOT NULL,
	`mapped_provider_id` text,
	`mapped_model_id` text,
	`mapping_mode` text NOT NULL,
	`input_override_usd` real,
	`output_override_usd` real,
	`cache_read_override_usd` real,
	`cache_write_override_usd` real,
	`reasoning_override_usd` real,
	`input_audio_override_usd` real,
	`output_audio_override_usd` real,
	`per_call_override_usd` real,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "site_model_price_rules_mapping_shape" CHECK(("site_model_price_rules"."mapping_mode" = 'manual' and "site_model_price_rules"."mapped_provider_id" is not null and "site_model_price_rules"."mapped_model_id" is not null)
      or ("site_model_price_rules"."mapping_mode" = 'custom' and "site_model_price_rules"."mapped_provider_id" is null and "site_model_price_rules"."mapped_model_id" is null)),
	CONSTRAINT "site_model_price_rules_non_negative" CHECK(("site_model_price_rules"."input_override_usd" is null or "site_model_price_rules"."input_override_usd" >= 0)
      and ("site_model_price_rules"."output_override_usd" is null or "site_model_price_rules"."output_override_usd" >= 0)
      and ("site_model_price_rules"."cache_read_override_usd" is null or "site_model_price_rules"."cache_read_override_usd" >= 0)
      and ("site_model_price_rules"."cache_write_override_usd" is null or "site_model_price_rules"."cache_write_override_usd" >= 0)
      and ("site_model_price_rules"."reasoning_override_usd" is null or "site_model_price_rules"."reasoning_override_usd" >= 0)
      and ("site_model_price_rules"."input_audio_override_usd" is null or "site_model_price_rules"."input_audio_override_usd" >= 0)
      and ("site_model_price_rules"."output_audio_override_usd" is null or "site_model_price_rules"."output_audio_override_usd" >= 0)
      and ("site_model_price_rules"."per_call_override_usd" is null or "site_model_price_rules"."per_call_override_usd" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_model_price_rules_site_model_unique` ON `site_model_price_rules` (`site_id`,`upstream_model_id`);--> statement-breakpoint
CREATE INDEX `site_model_price_rules_site_id_idx` ON `site_model_price_rules` (`site_id`);--> statement-breakpoint
CREATE TABLE `site_model_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`upstream_model_id` text NOT NULL,
	`input_per_million_usd` real,
	`output_per_million_usd` real,
	`cache_read_per_million_usd` real,
	`cache_write_per_million_usd` real,
	`reasoning_per_million_usd` real,
	`input_audio_per_million_usd` real,
	`output_audio_per_million_usd` real,
	`per_call_usd` real,
	`pricing_semantics` text NOT NULL,
	`raw_metadata_json` text,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "site_model_prices_semantics_valid" CHECK("site_model_prices"."pricing_semantics" in ('base_price', 'price_includes_group_ratio', 'model_ratio')),
	CONSTRAINT "site_model_prices_non_negative" CHECK(("site_model_prices"."input_per_million_usd" is null or "site_model_prices"."input_per_million_usd" >= 0)
      and ("site_model_prices"."output_per_million_usd" is null or "site_model_prices"."output_per_million_usd" >= 0)
      and ("site_model_prices"."cache_read_per_million_usd" is null or "site_model_prices"."cache_read_per_million_usd" >= 0)
      and ("site_model_prices"."cache_write_per_million_usd" is null or "site_model_prices"."cache_write_per_million_usd" >= 0)
      and ("site_model_prices"."reasoning_per_million_usd" is null or "site_model_prices"."reasoning_per_million_usd" >= 0)
      and ("site_model_prices"."input_audio_per_million_usd" is null or "site_model_prices"."input_audio_per_million_usd" >= 0)
      and ("site_model_prices"."output_audio_per_million_usd" is null or "site_model_prices"."output_audio_per_million_usd" >= 0)
      and ("site_model_prices"."per_call_usd" is null or "site_model_prices"."per_call_usd" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_model_prices_site_model_unique` ON `site_model_prices` (`site_id`,`upstream_model_id`);--> statement-breakpoint
CREATE INDEX `site_model_prices_site_id_idx` ON `site_model_prices` (`site_id`);--> statement-breakpoint
CREATE TABLE `site_pricing_profiles` (
	`site_id` integer PRIMARY KEY NOT NULL,
	`paid_cny` real DEFAULT 1 NOT NULL,
	`credited_usd` real DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "site_pricing_profiles_positive_amounts" CHECK("site_pricing_profiles"."paid_cny" > 0 and "site_pricing_profiles"."credited_usd" > 0)
);
--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `unit_cost`;