DROP INDEX `service_tokens_name_unique`;--> statement-breakpoint
CREATE INDEX `service_tokens_name_idx` ON `service_tokens` (`name`);