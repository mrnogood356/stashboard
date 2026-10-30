import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import {
  BackupApiService,
  BackupSummary,
  RestoreResult,
  summarizeBackup,
} from '../../core/api/backup.service';

const STATUS_ICON: Record<RestoreResult['status'], string> = {
  restored: 'pi pi-check-circle',
  warning: 'pi pi-exclamation-triangle',
  failed: 'pi pi-times-circle',
};

/**
 * Download every setting as one file, and put such a file back: for moving
 * Stashboard to another server, or starting over without setting it all up
 * again.
 */
@Component({
  selector: 'app-settings-backup-section',
  templateUrl: './settings-backup-section.component.html',
  styleUrls: ['./settings-backup-section.component.scss', './settings-shared.scss'],
})
export class SettingsBackupSectionComponent {
  private readonly api = inject(BackupApiService);

  protected readonly includeSecrets = signal(true);
  protected readonly downloading = signal(false);
  protected readonly downloadError = signal<string | null>(null);

  protected readonly fileName = signal<string | null>(null);
  protected readonly file = signal<unknown>(null);
  protected readonly summary = signal<BackupSummary | null>(null);
  protected readonly fileError = signal<string | null>(null);
  protected readonly restoring = signal(false);
  protected readonly restoreError = signal<string | null>(null);
  protected readonly results = signal<RestoreResult[] | null>(null);

  protected download(): void {
    this.downloading.set(true);
    this.downloadError.set(null);
    this.api.download(this.includeSecrets()).subscribe({
      next: ({ blob, fileName }) => {
        this.downloading.set(false);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      },
      error: () => {
        this.downloading.set(false);
        this.downloadError.set('Couldn’t make the backup. Try again in a moment.');
      },
    });
  }

  protected async choose(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const picked = input.files?.[0];
    input.value = '';
    this.reset();
    if (!picked) {
      return;
    }
    this.fileName.set(picked.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await picked.text());
    } catch {
      this.fileError.set('That file isn’t a Stashboard backup.');
      return;
    }
    const summary = summarizeBackup(parsed);
    if (!summary) {
      this.fileError.set('That file isn’t a Stashboard backup.');
      return;
    }
    this.file.set(parsed);
    this.summary.set(summary);
  }

  protected restore(): void {
    const file = this.file();
    if (!file) {
      return;
    }
    this.restoring.set(true);
    this.restoreError.set(null);
    this.api.restore(file).subscribe({
      next: (response) => {
        this.restoring.set(false);
        this.results.set(response.results);
        this.file.set(null);
      },
      error: (error: unknown) => {
        this.restoring.set(false);
        this.restoreError.set(messageFrom(error));
      },
    });
  }

  protected cancel(): void {
    this.reset();
  }

  protected reload(): void {
    location.reload();
  }

  protected statusIcon(status: RestoreResult['status']): string {
    return STATUS_ICON[status];
  }

  protected when(iso: string | null): string {
    if (!iso) {
      return 'an unknown date';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  private reset(): void {
    this.fileName.set(null);
    this.file.set(null);
    this.summary.set(null);
    this.fileError.set(null);
    this.restoreError.set(null);
    this.results.set(null);
  }
}

function messageFrom(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const message = (error.error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  return 'Couldn’t restore the backup. Try again in a moment.';
}
