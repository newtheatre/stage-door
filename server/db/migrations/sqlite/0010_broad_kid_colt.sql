CREATE TABLE `eligibility_snapshots` (
	`rule_key` text NOT NULL,
	`user_id` text NOT NULL,
	`captured_at` integer NOT NULL,
	PRIMARY KEY(`rule_key`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `eligibility_snapshots_user_idx` ON `eligibility_snapshots` (`user_id`);--> statement-breakpoint
CREATE TABLE `eligibility_syncs` (
	`rule_key` text PRIMARY KEY NOT NULL,
	`last_attempt_at` integer,
	`last_success_at` integer,
	`user_count` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
ALTER TABLE `user_roles` ADD `eligibility_override_until` integer;--> statement-breakpoint
CREATE INDEX `user_roles_role_idx` ON `user_roles` (`role`);