CREATE TABLE `app_manifests` (
	`app_id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`document_hash` text NOT NULL,
	`version` text NOT NULL,
	`etag` text,
	`fetched_at` integer NOT NULL,
	`applied_at` integer,
	`last_attempt_at` integer,
	`last_error` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `app_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`description` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_permissions_namespace_key_unique` ON `app_permissions` (`namespace`,`key`);--> statement-breakpoint
CREATE TABLE `role_definition_permissions` (
	`role_definition_id` text NOT NULL,
	`permission_id` text NOT NULL,
	PRIMARY KEY(`role_definition_id`, `permission_id`),
	FOREIGN KEY (`role_definition_id`) REFERENCES `role_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_id`) REFERENCES `app_permissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `role_definition_permissions_permission_idx` ON `role_definition_permissions` (`permission_id`);--> statement-breakpoint
ALTER TABLE `role_definitions` ADD `app_id` text;--> statement-breakpoint
ALTER TABLE `role_definitions` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `role_definitions` ADD `manifest_version` text;--> statement-breakpoint
ALTER TABLE `role_definitions` ADD `withdrawn_at` integer;--> statement-breakpoint
ALTER TABLE `role_definitions` ADD `synced_at` integer;--> statement-breakpoint
ALTER TABLE `role_definitions` ADD `requires_eligibility_key` text;--> statement-breakpoint
ALTER TABLE `role_definitions` ADD `eligibility_mode` text DEFAULT 'advisory' NOT NULL;--> statement-breakpoint
ALTER TABLE `role_definitions` ADD `default_expiry_pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `role_definitions` ADD `eligibility_mode_pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `role_definitions_app_id_idx` ON `role_definitions` (`app_id`);