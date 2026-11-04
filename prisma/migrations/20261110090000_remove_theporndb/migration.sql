-- ThePornDB's stash-box endpoint can't list scenes, so it's no longer a
-- catalog: drop any saved ThePornDB integration and the enum value.
DELETE FROM "IntegrationConfig" WHERE "type" = 'THEPORNDB';

ALTER TYPE "IntegrationType" RENAME TO "IntegrationType_old";
CREATE TYPE "IntegrationType" AS ENUM ('STASHDB', 'STASH', 'WHISPARR', 'FANSDB', 'PROWLARR', 'SABNZBD');
ALTER TABLE "IntegrationConfig"
  ALTER COLUMN "type" TYPE "IntegrationType" USING ("type"::text::"IntegrationType");
DROP TYPE "IntegrationType_old";
