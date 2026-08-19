CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`namespace` text NOT NULL,
	`display_name` text NOT NULL,
	`base_url` text NOT NULL,
	`hooks_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_name_unique` ON `apps` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `apps_namespace_unique` ON `apps` (`namespace`);--> statement-breakpoint
CREATE INDEX `apps_namespace_idx` ON `apps` (`namespace`);--> statement-breakpoint
ALTER TABLE `service_tokens` ADD `app_id` text REFERENCES apps(id);