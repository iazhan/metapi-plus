CREATE TABLE IF NOT EXISTS `site_model_aliases` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `site_id` INT NOT NULL, `source_model` TEXT NOT NULL, `alias_model` TEXT NOT NULL, `alias_key` TEXT NOT NULL, `enabled` BOOLEAN NOT NULL DEFAULT true, `created_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), `updated_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE);
ALTER TABLE `token_routes` ADD COLUMN `route_kind` TEXT;
CREATE UNIQUE INDEX `site_model_aliases_site_alias_key_unique` ON `site_model_aliases` (`site_id`, `alias_key`(191));
CREATE INDEX `site_model_aliases_site_id_idx` ON `site_model_aliases` (`site_id`);
