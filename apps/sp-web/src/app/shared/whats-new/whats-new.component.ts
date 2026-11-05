import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AboutApiService, ReleaseNotes } from '../../core/api/about.service';
import { WhatsNewService } from './whats-new.service';

/** The last version this browser opened; "What's new" covers everything after it. */
export const SEEN_VERSION_KEY = 'sp-seen-version';
const RELEASE = /^v?\d+\.\d+\.\d+$/;

/**
 * After an update, a short note of what changed since this browser last
 * opened Stashboard, once. When the browser remembers no version (a first
 * visit, or Safari clearing its storage), the server answers with the release
 * it ran before, if it has one. Edge or local builds never show it on their
 * own; About's "What's new" opens it at any time.
 */
@Component({
  selector: 'app-whats-new',
  templateUrl: './whats-new.component.html',
  styleUrl: './whats-new.component.scss',
})
export class WhatsNewComponent implements AfterViewInit {
  private readonly api = inject(AboutApiService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    inject(WhatsNewService)
      .requests.pipe(takeUntilDestroyed(inject(DestroyRef)))
      .subscribe(() => this.showLatest());
  }

  protected readonly releases = signal<ReleaseNotes[]>([]);
  protected readonly current = signal<string | null>(null);
  protected readonly title = computed(() =>
    this.current() ? `What’s new in Stashboard ${this.current()}` : 'What’s new',
  );

  /** Asked once the (closed) dialog is on the page, so it can open straight away. */
  ngAfterViewInit(): void {
    const seen = readSeen();
    this.api.changes(seen).subscribe({
      next: ({ current, releases }) => {
        if (!RELEASE.test(current)) {
          return;
        }
        if (releases.length === 0) {
          writeSeen(current);
          return;
        }
        this.current.set(current);
        this.releases.set(releases);
        this.open();
      },
      // Not worth bothering anyone about; it asks again next time.
      error: () => undefined,
    });
  }

  /** About's "What's new": the running release's notes, whenever asked. */
  private showLatest(): void {
    this.api.latestChanges().subscribe({
      next: ({ current, releases }) => {
        if (releases.length === 0) {
          return;
        }
        this.current.set(RELEASE.test(current) ? current : releases[0].version);
        this.releases.set(releases);
        this.open();
      },
      error: () => undefined,
    });
  }

  private dialogElement(): HTMLDialogElement | null {
    return this.host.nativeElement.querySelector('dialog');
  }

  private open(): void {
    const dialog = this.dialogElement();
    if (!dialog || dialog.open) {
      return;
    }
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  protected close(): void {
    const current = this.current();
    if (current) {
      writeSeen(current);
    }
    const dialog = this.dialogElement();
    if (dialog?.open) {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
    }
    this.releases.set([]);
  }

  protected when(date: string | null): string {
    if (!date) {
      return '';
    }
    const parsed = new Date(`${date}T12:00:00`);
    return Number.isNaN(parsed.getTime())
      ? date
      : parsed.toLocaleDateString([], { dateStyle: 'medium' });
  }
}

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_VERSION_KEY);
  } catch {
    return null;
  }
}

function writeSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_VERSION_KEY, version);
  } catch {
    // Private mode: it shows again next time, which is fine.
  }
}
