import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AutomationApiService, AutomationSettings } from '../../core/api/automation.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

type ToggleKey =
  | 'scanOnImport'
  | 'identifyNew'
  | 'generateNew'
  | 'removeSamples'
  | 'watchFolders'
  | 'tidyAfterImport';

/**
 * New scenes from Whisparr: have Stash scan for them, identify them on
 * StashDB and make their previews, without opening Stash.
 */
@Component({
  selector: 'app-settings-automation-page',
  imports: [RouterLink],
  templateUrl: './settings-automation-page.component.html',
  styleUrls: ['./settings-automation-page.component.scss', './settings-shared.scss'],
})
export class SettingsAutomationPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(AutomationApiService);
  private readonly notifications = inject(AppNotificationsService);
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly settings = signal<AutomationSettings | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal<ToggleKey | null>(null);
  protected readonly copied = signal(false);
  protected readonly webhookUrl = computed(() => {
    const path = this.settings()?.webhookPath;
    return path ? `${window.location.origin}${path}` : '';
  });

  ngOnInit(): void {
    this.load();
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
  }

  protected toggle(key: ToggleKey): void {
    const current = this.settings();
    if (!current || this.saving()) {
      return;
    }
    const value = !current[key];
    this.saving.set(key);
    this.settings.set({ ...current, [key]: value });
    this.api.update({ [key]: value }).subscribe({
      next: (saved) => {
        this.settings.set(saved);
        this.saving.set(null);
      },
      error: () => {
        this.settings.set(current);
        this.saving.set(null);
        this.notifications.error("Couldn't save", 'Try again in a moment.');
      },
    });
  }

  protected runNow(): void {
    this.api.runNow().subscribe({
      next: (settings) => {
        this.settings.set({ ...settings, running: true });
        this.notifications.success('Started', 'Stash is scanning for new files.');
        this.schedulePoll(2000);
      },
      error: () => this.notifications.error("Couldn't start", 'Check that Stash is running.'),
    });
  }

  protected async copyUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.webhookUrl());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.notifications.info('Copy the address', 'Press and hold the address to copy it.');
    }
  }

  protected regenerate(): void {
    if (
      !window.confirm(
        'Make a new webhook address? The old one stops working, so update it in Whisparr.',
      )
    ) {
      return;
    }
    this.api.regenerateToken().subscribe({
      next: (settings) => this.settings.set(settings),
      error: () =>
        this.notifications.error("Couldn't make a new address", 'Try again in a moment.'),
    });
  }

  protected statusLabel(settings: AutomationSettings): string {
    if (settings.running || settings.lastRun.status === 'RUNNING') {
      return 'Running';
    }
    switch (settings.lastRun.status) {
      case 'DONE':
        return 'Done';
      case 'FAILED':
        return 'Failed';
      default:
        return 'Not run yet';
    }
  }

  protected reasonLabel(reason: string | null): string {
    switch (reason) {
      case 'webhook':
        return 'Whisparr imported a scene';
      case 'detected':
        return 'Noticed a scene waiting for Stash';
      case 'files':
        return 'New files in your library folders';
      case 'manual':
        return 'You ran it';
      default:
        return '';
    }
  }

  protected when(iso: string | null): string {
    if (!iso) {
      return '';
    }
    const date = new Date(iso);
    const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
    if (minutes < 1) {
      return 'just now';
    }
    if (minutes < 60) {
      return `${minutes} min ago`;
    }
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  private load(): void {
    this.api.get().subscribe({
      next: (settings) => {
        this.settings.set(settings);
        this.error.set(null);
        if (settings.running || settings.lastRun.status === 'RUNNING') {
          this.schedulePoll(3000);
        }
      },
      error: () => this.error.set("Couldn't load automation settings."),
    });
  }

  private schedulePoll(delay: number): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => this.load(), delay);
  }
}
