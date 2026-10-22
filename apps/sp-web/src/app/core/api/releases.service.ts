import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { DiscoverService } from './discover.service';
import { OwnedCopies } from './discover.types';
import { CatalogProviderType } from './integrations.types';

/**
 * How well a release's name fits the scene: `strong` has two or more of
 * studio, date, a performer and the title; `partial` one; `weak` none, or
 * another date.
 */
export interface ReleaseMatch {
  strength: 'strong' | 'partial' | 'weak';
  matched: string[];
}

export interface WhisparrRelease {
  guid: string;
  indexerId: number;
  indexer: string | null;
  title: string;
  size: number | null;
  quality: string | null;
  resolution: number | null;
  protocol: 'torrent' | 'usenet' | null;
  seeders: number | null;
  leechers: number | null;
  ageHours: number | null;
  customFormatScore: number | null;
  rejected: boolean;
  rejections: string[];
  languages: string[];
  infoUrl: string | null;
  downloadAllowed: boolean;
  /** Null when Stashboard knows too little about the scene to tell. */
  match?: ReleaseMatch | null;
}

/** A release Prowlarr's indexers found, as the API sends it. */
export interface ProwlarrRelease {
  guid: string;
  indexerId: number;
  indexer: string | null;
  title: string;
  size: number | null;
  protocol: 'torrent' | 'usenet' | null;
  seeders: number | null;
  leechers: number | null;
  ageHours: number | null;
  publishDate: string | null;
  infoUrl: string | null;
  match: ReleaseMatch | null;
}

/** Where a Find downloads grab went: Prowlarr's client, or SABnzbd (Finished downloads). */
export interface ProwlarrGrabResult {
  accepted: true;
  sentTo?: 'prowlarr' | 'sabnzbd';
}

export interface ReleaseSearchResult {
  releases: WhisparrRelease[];
  /** Why the search may have come back empty. */
  notice?: string;
  /** What was searched for (Prowlarr). */
  queries?: string[];
}

@Injectable({ providedIn: 'root' })
export class ReleasesApiService {
  private readonly http = inject(HttpClient);
  private readonly discover = inject(DiscoverService);

  /** Copies of the scene you likely already have, checked before a download. */
  ownedCopies(sceneId: string, provider: CatalogProviderType | null): Observable<OwnedCopies> {
    return this.discover.getOwnedCopies(sceneId, provider);
  }

  search(
    stashId: string,
  ): Observable<{ movieId: number; releases: WhisparrRelease[]; notice?: string }> {
    return this.http.get<{ movieId: number; releases: WhisparrRelease[]; notice?: string }>(
      `/api/requests/${encodeURIComponent(stashId)}/releases`,
    );
  }

  grab(
    stashId: string,
    release: Pick<WhisparrRelease, 'guid' | 'indexerId'>,
  ): Observable<{ accepted: true }> {
    return this.http.post<{ accepted: true }>(
      `/api/requests/${encodeURIComponent(stashId)}/releases`,
      {
        guid: release.guid,
        indexerId: release.indexerId,
      },
    );
  }

  /** Whether Prowlarr is set up, so "Find downloads" can be offered. */
  prowlarrStatus(): Observable<{ prowlarr: { configured: boolean } }> {
    return this.http.get<{ prowlarr: { configured: boolean } }>('/api/downloads/status');
  }

  /**
   * Prowlarr's releases for a scene from any catalog, shaped like Whisparr's
   * so the release picker shows both the same way.
   */
  searchProwlarr(
    sceneId: string,
    provider: CatalogProviderType,
    /** Your own words, searched as typed. */
    query?: string,
  ): Observable<ReleaseSearchResult> {
    return this.http
      .get<{ releases: ProwlarrRelease[]; queries: string[]; notice?: string }>(
        `/api/downloads/scenes/${encodeURIComponent(sceneId)}/releases`,
        { params: query?.trim() ? { provider, q: query.trim() } : { provider } },
      )
      .pipe(
        map((result) => ({
          releases: result.releases.map(fromProwlarr),
          queries: result.queries,
          ...(result.notice ? { notice: result.notice } : {}),
        })),
      );
  }

  grabProwlarr(
    sceneId: string,
    provider: CatalogProviderType,
    release: Pick<WhisparrRelease, 'guid' | 'indexerId' | 'title' | 'indexer'>,
  ): Observable<ProwlarrGrabResult> {
    return this.http.post<ProwlarrGrabResult>(
      `/api/downloads/scenes/${encodeURIComponent(sceneId)}/releases`,
      {
        guid: release.guid,
        indexerId: release.indexerId,
        provider,
        title: release.title,
        ...(release.indexer ? { indexer: release.indexer } : {}),
      },
    );
  }
}

/** Prowlarr has no quality profiles or rejections; everything can be downloaded. */
function fromProwlarr(release: ProwlarrRelease): WhisparrRelease {
  return {
    guid: release.guid,
    indexerId: release.indexerId,
    indexer: release.indexer,
    title: release.title,
    size: release.size,
    quality: null,
    resolution: null,
    protocol: release.protocol,
    seeders: release.seeders,
    leechers: release.leechers,
    ageHours: release.ageHours,
    customFormatScore: null,
    rejected: false,
    rejections: [],
    languages: [],
    infoUrl: release.infoUrl,
    downloadAllowed: true,
    match: release.match,
  };
}
