-- A pending marker beats an address match at sign-in, so one pointing at an
-- address another account already holds would divert that owner's login.
UPDATE `users` SET `pending_google_email` = NULL
WHERE `pending_google_email` IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM `users` AS `owner`
		WHERE `owner`.`email` = `users`.`pending_google_email` AND `owner`.`id` <> `users`.`id`
	);
--> statement-breakpoint
-- Duplicates pick an arbitrary winner, so clear every side and let an admin
-- set it again deliberately. The unique index that follows needs this first.
UPDATE `users` SET `pending_google_email` = NULL
WHERE `pending_google_email` IN (
	SELECT `pending_google_email` FROM `users`
	WHERE `pending_google_email` IS NOT NULL
	GROUP BY `pending_google_email` HAVING COUNT(*) > 1
);
