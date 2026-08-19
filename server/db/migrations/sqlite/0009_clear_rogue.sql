ALTER TABLE `apps` ADD `manifest_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `last_synced_at` integer;