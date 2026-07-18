CREATE TABLE `site_model_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`source_model` text NOT NULL,
	`alias_model` text NOT NULL,
	`alias_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_model_aliases_site_alias_key_unique` ON `site_model_aliases` (`site_id`,`alias_key`);--> statement-breakpoint
CREATE INDEX `site_model_aliases_site_id_idx` ON `site_model_aliases` (`site_id`);--> statement-breakpoint
ALTER TABLE `token_routes` ADD `route_kind` text;