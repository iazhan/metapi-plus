CREATE TABLE `account_group_rates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`group_key` text NOT NULL,
	`group_name` text NOT NULL,
	`description` text,
	`ratio` real NOT NULL,
	`last_synced_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_group_rates_ratio_non_negative" CHECK("account_group_rates"."ratio" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_group_rates_account_group_unique` ON `account_group_rates` (`account_id`,`group_key`);--> statement-breakpoint
CREATE INDEX `account_group_rates_account_id_idx` ON `account_group_rates` (`account_id`);