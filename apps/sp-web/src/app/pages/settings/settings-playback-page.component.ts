import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import {
  PlaybackSettings,
  PlaybackSettingsService,
} from '../../core/playback/playback-settings.service';

type Switch = keyof PlaybackSettings;

/**
 * Settings → Playback: turn Stashboard's own player, swipe feed and card
 * previews off, for installs that only use it to find and download scenes.
 * Each switch saves straight away.
 */
@Component({
  selector: 'app-settings-playback-page',
  templateUrl: './settings-playback-page.component.html',
  styleUrls: ['./settings-playback-page.component.scss', './settings-shared.scss'],
})
export class SettingsPlaybackPageComponent implements OnInit {
  private readonly playback = inject(PlaybackSettingsService);

  protected readonly settings = this.playback.settings;
  protected readonly loaded = this.playback.loaded;
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly status = signal<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async ngOnInit(): Promise<void> {
    await this.playback.ensureLoaded();
    this.loadFailed.set(!this.playback.loaded());
  }

  protected async retry(): Promise<void> {
    this.loadFailed.set(false);
    await this.ngOnInit();
  }

  protected async toggle(field: Switch, input: HTMLInputElement): Promise<void> {
    const previous = this.settings();
    const next: PlaybackSettings = { ...previous, [field]: input.checked };
    this.saving.set(true);
    this.status.set(null);
    try {
      await this.playback.save(next);
      this.status.set({ kind: 'ok', text: 'Saved. Applied right away.' });
    } catch (error: unknown) {
      input.checked = previous[field];
      this.status.set({
        kind: 'error',
        text: messageFrom(error, 'Couldn’t save the playback settings.'),
      });
    } finally {
      this.saving.set(false);
    }
  }
}

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const message = (error.error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  return fallback;
}
