import { IntegrationType, RuntimeHealthServiceKey } from '@prisma/client';

// Prowlarr and SABnzbd are optional, so they have no runtime health of their
// own: when one is down, only downloads stop working, never the rest of the app.
const INTEGRATION_RUNTIME_HEALTH_SERVICE_MAP: Record<
  IntegrationType,
  RuntimeHealthServiceKey | null
> = {
  [IntegrationType.STASH]: RuntimeHealthServiceKey.STASH,
  [IntegrationType.WHISPARR]: RuntimeHealthServiceKey.WHISPARR,
  [IntegrationType.STASHDB]: RuntimeHealthServiceKey.CATALOG,
  [IntegrationType.FANSDB]: RuntimeHealthServiceKey.CATALOG,
  [IntegrationType.PROWLARR]: null,
  [IntegrationType.SABNZBD]: null,
};

export function runtimeHealthServiceForIntegration(
  type: IntegrationType,
): RuntimeHealthServiceKey | null {
  return INTEGRATION_RUNTIME_HEALTH_SERVICE_MAP[type];
}
