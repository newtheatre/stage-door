INSERT OR IGNORE INTO `apps` (`id`, `name`, `namespace`, `display_name`, `base_url`, `hooks_enabled`, `created_at`) VALUES
	('app_proscenium', 'proscenium', 'proscenium', 'Proscenium', 'https://newtheatre.org.uk', 1, 1786700000000),
	('app_rooms', 'rooms', 'rooms', 'Rooms', 'https://rooms.newtheatre.org.uk', 1, 1786700000000),
	('app_rehearsal', 'rehearsal', 'training', 'Training', 'https://training.newtheatre.org.uk', 1, 1786700000000);
--> statement-breakpoint
UPDATE `service_tokens` SET `app_id` = (SELECT `id` FROM `apps` WHERE `apps`.`name` = `service_tokens`.`name`) WHERE `app_id` IS NULL;
