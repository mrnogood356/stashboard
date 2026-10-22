import { Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { CatalogProviderType } from '../api/integrations.types';
import { ReleasesApiService } from '../api/releases.service';
import type { ReleaseSource } from '../../shared/release-picker/release-picker.component';

export interface ReleaseSearchTarget {
  stashId: string;
  title: string | null;
  source: ReleaseSource;
  provider?: CatalogProviderType | null;
}

/**
 * Opens "Pick a release" from anywhere, a scene card in a list say, without
 * going to the scene's page first. One picker on the app's root shows it.
 */
@Injectable({ providedIn: 'root' })
export class ReleaseSearchService {
  private readonly api = inject(ReleasesApiService);
  readonly target = signal<ReleaseSearchTarget | null>(null);
  /** Whether Prowlarr is set up, so lists can offer Find downloads; null until known. */
  readonly prowlarrReady = signal<boolean | null>(null);
  private prowlarrAsked = false;
  /** A release was sent to download: lists showing that scene can refresh. */
  readonly grabbed = new Subject<string>();

  /** Asks the server once whether Prowlarr is set up. */
  checkProwlarr(): void {
    if (this.prowlarrAsked) {
      return;
    }
    this.prowlarrAsked = true;
    this.api.prowlarrStatus().subscribe({
      next: (status) => this.prowlarrReady.set(status.prowlarr.configured),
      error: () => this.prowlarrReady.set(false),
    });
  }

  open(target: ReleaseSearchTarget): void {
    this.target.set(target);
  }

  close(): void {
    this.target.set(null);
  }

  /** Called by the picker once a release was sent to download. */
  done(): void {
    const target = this.target();
    this.target.set(null);
    if (target) {
      this.grabbed.next(target.stashId);
    }
  }
}
