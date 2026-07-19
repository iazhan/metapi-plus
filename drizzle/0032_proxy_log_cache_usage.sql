ALTER TABLE `proxy_logs` ADD `cache_read_tokens` integer;
--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD `cache_creation_tokens` integer;
--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD `prompt_tokens_include_cache` integer;
