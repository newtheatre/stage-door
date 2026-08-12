CREATE TABLE `role_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`role` text NOT NULL,
	`description` text NOT NULL,
	`default_expiry_kind` text DEFAULT 'none' NOT NULL,
	`default_expiry_days` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_definitions_namespace_role_unique` ON `role_definitions` (`namespace`,`role`);--> statement-breakpoint
ALTER TABLE `user_roles` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `user_roles` ADD `granted_by` text;--> statement-breakpoint
ALTER TABLE `user_roles` ADD `granted_at` integer;--> statement-breakpoint
ALTER TABLE `user_roles` ADD `note` text;--> statement-breakpoint
ALTER TABLE `user_roles` ADD `expiry_warned_at` integer;