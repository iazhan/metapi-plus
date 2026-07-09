ALTER TABLE `proxy_logs` ADD `compatibility_notes` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `responses_strip_image_generation_enabled` integer DEFAULT false NOT NULL;
