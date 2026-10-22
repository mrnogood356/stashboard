import { Component, Input, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonDirective } from 'primeng/button';
import { Message } from 'primeng/message';
import { DownloadHandoffApiService } from '../../core/api/download-handoff.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

/**
 * SABnzbd's "Finished downloads" settings, under its integration card: where
 * finished downloads go and how. What's on its way in is on the Processing
 * page, linked from here.
 */
@Component({
  selector: 'app-finished-downloads',
  imports: [ButtonDirective, Message, RouterLink],
  templateUrl: './finished-downloads.component.html',
  styleUrl: './finished-downloads.component.scss',
})
export class FinishedDownloadsComponent implements OnInit {
  private readonly api = inject(DownloadHandoffApiService);
  private readonly notifications = inject(AppNotificationsService);

  /** SABnzbd has passed its test. */
  @Input() sabnzbdReady = false;

  protected readonly loaded = signal(false);
  protected readonly loadError = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);

  protected readonly enabled = signal(false);
  protected readonly category = signal('stashboard');
  protected readonly destination = signal('');
  protected readonly sabPathFrom = signal('');
  protected readonly sabPathTo = signal('');
  protected readonly importMode = signal<'move' | 'copy'>('move');
  protected readonly libraryRoots = signal<string[]>([]);
  protected readonly dropIns = signal(false);
  /** Also bring in downloads added to the category in SABnzbd by hand. */
  protected readonly sabManualJobs = signal(true);
  /** SABnzbd's folder for the category, as Stashboard sees it. */
  protected readonly dropInFolder = signal<string | null>(null);

  ngOnInit(): void {
    this.api.settings().subscribe({
      next: (settings) => {
        this.enabled.set(settings.enabled);
        this.category.set(settings.category);
        this.destination.set(settings.destination ?? '');
        this.sabPathFrom.set(settings.sabPathFrom ?? '');
        this.sabPathTo.set(settings.sabPathTo ?? '');
        this.importMode.set(settings.importMode);
        this.libraryRoots.set(settings.libraryRoots);
        this.dropIns.set(settings.dropIns);
        this.sabManualJobs.set(settings.sabManualJobs);
        this.dropInFolder.set(settings.dropInFolder);
        this.loaded.set(true);
      },
      error: () => this.loadError.set(true),
    });
  }

  protected save(): void {
    if (this.saving()) {
      return;
    }
    this.saving.set(true);
    this.saveError.set(null);
    this.api
      .update({
        enabled: this.enabled(),
        category: this.category().trim(),
        destination: this.destination().trim(),
        sabPathFrom: this.sabPathFrom().trim(),
        sabPathTo: this.sabPathTo().trim(),
        importMode: this.importMode(),
        dropIns: this.dropIns(),
        sabManualJobs: this.sabManualJobs(),
      })
      .subscribe({
        next: (saved) => {
          this.saving.set(false);
          this.destination.set(saved.destination ?? '');
          this.sabPathFrom.set(saved.sabPathFrom ?? '');
          this.sabPathTo.set(saved.sabPathTo ?? '');
          this.dropInFolder.set(saved.dropInFolder);
          this.notifications.success(
            saved.enabled ? 'Finished downloads is on' : 'Finished downloads saved',
          );
        },
        error: (error: { error?: { message?: string | string[] } }) => {
          this.saving.set(false);
          const message = error?.error?.message;
          this.saveError.set(
            (Array.isArray(message) ? message[0] : message) ?? 'Couldn’t save. Try again.',
          );
        },
      });
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected setMode(event: Event): void {
    this.importMode.set(this.inputValue(event) === 'copy' ? 'copy' : 'move');
  }

  protected setEnabled(event: Event): void {
    this.enabled.set((event.target as HTMLInputElement).checked);
  }

  protected setDropIns(event: Event): void {
    this.dropIns.set((event.target as HTMLInputElement).checked);
  }

  protected setSabManualJobs(event: Event): void {
    this.sabManualJobs.set((event.target as HTMLInputElement).checked);
  }
}
