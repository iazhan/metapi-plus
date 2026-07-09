ALTER TABLE `proxy_logs` ADD COLUMN `compatibility_notes` TEXT;
ALTER TABLE `sites` ADD COLUMN `responses_strip_image_generation_enabled` BOOLEAN NOT NULL DEFAULT false;
