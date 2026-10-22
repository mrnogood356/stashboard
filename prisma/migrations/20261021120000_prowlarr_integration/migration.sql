-- Prowlarr: an optional integration for finding and downloading releases of
-- scenes Whisparr can't request (FansDB scenes, for one).
ALTER TYPE "IntegrationType" ADD VALUE IF NOT EXISTS 'PROWLARR';
