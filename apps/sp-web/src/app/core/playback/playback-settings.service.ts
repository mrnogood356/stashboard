import { HttpClient } from '@angular/common/http';
import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

const API = '/api/playback/settings';

export interface PlaybackSettings {
  /** The Watch page, Play buttons and streaming from Stash. Off turns all playback off. */
  enabled: boolean;
  /** The swipe feed of preview clips. */
  feedEnabled: boolean;
  /** Preview clips on scene cards (hover, or press and hold). */
  previewsEnabled: boolean;
}

export interface PlaybackSettingsResponse extends PlaybackSettings {
  updatedAt: string | null;
}

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = {
  enabled: true,
  feedEnabled: true,
  previewsEnabled: true,
};

/**
 * Settings → Playback: whether Stashboard's own player, swipe feed and card
 * previews are shown. Read from the server once and kept for the session;
 * saving here updates every page straight away. Everything is on until the
 * server has answered, which is how Stashboard behaves when never changed.
 */
@Injectable({ providedIn: 'root' })
export class PlaybackSettingsService {
  private readonly http = inject(HttpClient);
  private readonly state = signal<PlaybackSettings>(DEFAULT_PLAYBACK_SETTINGS);
  private readonly loadedState = signal(false);
  private loading: Promise<void> | null = null;

  readonly settings: Signal<PlaybackSettings> = this.state.asReadonly();
  readonly loaded: Signal<boolean> = this.loadedState.asReadonly();

  /** The player, Play buttons, chapters and Continue Watching. */
  readonly playbackEnabled = computed(() => this.state().enabled);
  /** The swipe feed (needs playback on too). */
  readonly feedEnabled = computed(() => this.state().enabled && this.state().feedEnabled);
  /** Preview clips on scene cards (needs playback on too). */
  readonly previewsEnabled = computed(() => this.state().enabled && this.state().previewsEnabled);

  /**
   * Fetches the settings the first time it's called; later calls reuse that
   * answer. A failure keeps everything on and lets the next call try again.
   */
  ensureLoaded(): Promise<void> {
    if (this.loadedState()) {
      return Promise.resolve();
    }
    this.loading ??= firstValueFrom(this.http.get<PlaybackSettingsResponse>(API))
      .then((response) => {
        this.adopt(response);
      })
      .catch(() => undefined)
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async save(settings: PlaybackSettings): Promise<PlaybackSettingsResponse> {
    const response = await firstValueFrom(
      this.http.put<PlaybackSettingsResponse>(API, {
        enabled: settings.enabled,
        feedEnabled: settings.feedEnabled,
        previewsEnabled: settings.previewsEnabled,
      }),
    );
    this.adopt(response);
    return response;
  }

  private adopt(response: PlaybackSettings): void {
    this.state.set({
      enabled: response.enabled !== false,
      feedEnabled: response.feedEnabled !== false,
      previewsEnabled: response.previewsEnabled !== false,
    });
    this.loadedState.set(true);
  }
}
