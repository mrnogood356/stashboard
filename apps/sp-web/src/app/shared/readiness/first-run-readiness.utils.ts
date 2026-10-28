import { RuntimeHealthResponse } from '../../core/api/runtime-health.types';
import { SetupStatusResponse } from '../../core/api/setup.types';

export type ReadinessSurface = 'home' | 'scenes' | 'library' | 'acquisition';
export type ReadinessService = 'CATALOG' | 'STASH' | 'WHISPARR';

export interface FirstUseEmptyStateCopy {
  title: string;
  message: string;
}

export interface ReadinessPageAlert {
  eyebrow: string;
  title: string;
  message: string;
  impactedServices: ReadinessService[];
}

export function setupCompleteSummary(catalogProviderLabel: string): string {
  return `${catalogProviderLabel}, Stash and Whisparr are set up. Home and Scenes work now; Library, Requests and the status on each scene fill in after the first sync.`;
}

export function initialIndexingGuidance(): string {
  return 'If Library is empty or Requests looks out of date, open Settings → Indexing and tap Sync now.';
}

export function firstUseEmptyStateCopy(surface: ReadinessSurface): FirstUseEmptyStateCopy {
  switch (surface) {
    case 'home':
      return {
        title: 'Home is still filling in',
        message:
          'You can browse Scenes now. If your library rails stay empty, run Sync now in Settings → Indexing.',
      };
    case 'scenes':
      return {
        title: 'No scenes from the catalog yet',
        message: 'If this stays empty, check the catalog in Settings → Integrations.',
      };
    case 'library':
      return {
        title: 'Your library hasn’t synced yet',
        message:
          'Run Sync now in Settings → Indexing to bring in your Stash library. You can keep browsing Scenes meanwhile.',
      };
    case 'acquisition':
      return {
        title: 'No requests yet',
        message:
          'Request a scene from Scenes and it shows up here. Already using Whisparr? Run Sync now in Settings → Indexing.',
      };
  }
}

export function buildReadinessPageAlert(
  surface: ReadinessSurface,
  setupStatus: SetupStatusResponse | null | undefined,
  runtimeStatus: RuntimeHealthResponse | null | undefined,
): ReadinessPageAlert | null {
  const setupImpacts = impactedSetupServices(setupStatus, surface);
  if (setupImpacts.length > 0) {
    return alertForImpacts(surface, setupImpacts, 'setup');
  }

  const runtimeImpacts = impactedRuntimeServices(runtimeStatus, surface);
  if (runtimeImpacts.length > 0) {
    return alertForImpacts(surface, runtimeImpacts, 'runtime');
  }

  return null;
}

function impactedSetupServices(
  status: SetupStatusResponse | null | undefined,
  surface: ReadinessSurface,
): ReadinessService[] {
  if (!status) {
    return [];
  }

  const services = servicesForSurface(surface);
  return services.filter((service) => {
    switch (service) {
      case 'CATALOG':
        return !status.required.catalog;
      case 'STASH':
        return !status.required.stash;
      case 'WHISPARR':
        return !status.required.whisparr;
    }
  });
}

function impactedRuntimeServices(
  status: RuntimeHealthResponse | null | undefined,
  surface: ReadinessSurface,
): ReadinessService[] {
  if (!status?.degraded) {
    return [];
  }

  return servicesForSurface(surface).filter((service) => {
    switch (service) {
      case 'CATALOG':
        return status.services.catalog.degraded;
      case 'STASH':
        return status.services.stash.degraded;
      case 'WHISPARR':
        return status.services.whisparr.degraded;
    }
  });
}

function servicesForSurface(surface: ReadinessSurface): ReadinessService[] {
  switch (surface) {
    case 'home':
      return ['CATALOG', 'STASH', 'WHISPARR'];
    case 'scenes':
      return ['CATALOG', 'STASH', 'WHISPARR'];
    case 'library':
      return ['STASH'];
    case 'acquisition':
      return ['WHISPARR', 'STASH'];
  }
}

function alertForImpacts(
  surface: ReadinessSurface,
  impactedServices: ReadinessService[],
  source: 'setup' | 'runtime',
): ReadinessPageAlert {
  const setup = source === 'setup';
  const eyebrow = setup ? 'Needs setting up' : 'Can’t reach a service';
  const services = new Set(impactedServices);
  const alert = (title: string, message: string): ReadinessPageAlert => ({
    eyebrow,
    impactedServices,
    title,
    message,
  });

  switch (surface) {
    case 'home':
      return setup
        ? alert(
            'Some of Home needs setting up',
            `A service Home relies on isn’t set up yet, so some rails stay empty.`,
          )
        : alert(
            'Some of Home can’t load',
            'A service Home relies on isn’t answering, so some rails may be empty or out of date.',
          );
    case 'scenes':
      if (services.has('CATALOG')) {
        return setup
          ? alert(
              'The catalog needs setting up',
              `Scenes come from the catalog, so there’s nothing to show until it’s set up.`,
            )
          : alert(
              'The catalog isn’t answering',
              'Scenes come from the catalog, so results may be empty or out of date until it answers again.',
            );
      }

      return setup
        ? alert(
            'Scene statuses need setting up',
            `You can keep browsing, but “In library” and download badges need Whisparr and Stash set up.`,
          )
        : alert(
            'Scene statuses may be out of date',
            'You can keep browsing, but “In library” and download badges may be behind until Whisparr and Stash answer again.',
          );
    case 'library':
      return setup
        ? alert(
            'Stash needs setting up',
            `Library comes from Stash, so it stays empty until Stash is set up.`,
          )
        : alert(
            'Stash isn’t answering',
            'Library comes from Stash, so new scenes, pictures and favourites may be missing until it answers again.',
          );
    case 'acquisition':
      if (services.has('WHISPARR') && services.has('STASH')) {
        return setup
          ? alert(
              'Whisparr and Stash need setting up',
              `Requests go through Whisparr and land in Stash, so both need setting up.`,
            )
          : alert(
              'Whisparr and Stash aren’t answering',
              'Progress, failures and new arrivals may be out of date until both answer again.',
            );
      }

      if (services.has('WHISPARR')) {
        return setup
          ? alert(
              'Whisparr needs setting up',
              `Requests go through Whisparr, so nothing moves until it’s set up.`,
            )
          : alert(
              'Whisparr needs attention',
              'Download progress and failures may be out of date until Whisparr answers again.',
            );
      }

      return setup
        ? alert(
            'Stash needs setting up',
            `Finished downloads can’t show as in your library until Stash is set up.`,
          )
        : alert(
            'Stash isn’t answering',
            'Finished downloads may take longer to show as in your library until Stash answers again.',
          );
  }
}
