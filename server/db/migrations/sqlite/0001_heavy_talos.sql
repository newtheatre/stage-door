CREATE TABLE `retention_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`stage` text NOT NULL,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `retention_notices_user_id_idx` ON `retention_notices` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `retention_notices_user_stage_unique` ON `retention_notices` (`user_id`,`stage`);