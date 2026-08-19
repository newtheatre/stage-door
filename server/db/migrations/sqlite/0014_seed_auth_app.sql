-- This service is an app like any other: its own roles come from its own
-- manifest (ADR-0024). manifest_enabled, but hooks_enabled 0 (it is the
-- thing hooks are called from). No service token: the sync reads the
-- manifest in-process rather than fetching itself over the network.
INSERT OR IGNORE INTO `apps` (`id`, `name`, `namespace`, `display_name`, `base_url`, `hooks_enabled`, `manifest_enabled`, `created_at`) VALUES
	('app_stage_door', 'stage-door', 'auth', 'Identity', 'https://auth.newtheatre.org.uk', 0, 1, 1787182200000);
--> statement-breakpoint
-- Adopt any hand-made auth:* definitions so the first sync updates rather
-- than duplicating them. Everything else keeps source = 'manual'.
UPDATE `role_definitions`
SET `app_id` = 'app_stage_door', `source` = 'manifest'
WHERE `namespace` = 'auth' AND `source` = 'manual';
