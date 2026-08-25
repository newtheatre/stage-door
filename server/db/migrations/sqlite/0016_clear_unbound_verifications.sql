-- Tokens minted before `email` existed name no address, so nothing can check
-- what they prove. They live at most 24h and /api/auth/email/request reissues.
DELETE FROM `email_verifications` WHERE `email` IS NULL;
