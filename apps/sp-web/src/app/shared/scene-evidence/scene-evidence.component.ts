import {
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  inject,
  signal,
} from '@angular/core';
import { Subscription } from 'rxjs';
import {
  DiagnosticsApiService,
  SceneEvidence,
  evidenceText,
} from '../../core/api/diagnostics.service';

/** How long "Copied" shows after a copy. */
const COPIED_MS = 2000;

let nextId = 0;

/**
 * "Status details": what Stashboard, Whisparr and Stash each say about a
 * scene, as plain facts. Collapsed until opened, and only asks the server
 * then, so it costs nothing on the page. Each part fails on its own.
 */
@Component({
  selector: 'app-scene-evidence',
  templateUrl: './scene-evidence.component.html',
  styleUrl: './scene-evidence.component.scss',
})
export class SceneEvidenceComponent implements OnChanges, OnDestroy {
  private readonly api = inject(DiagnosticsApiService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private request: Subscription | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  /** A catalog (StashDB/FansDB) scene, or a scene in your Stash library. */
  @Input({ required: true }) kind!: 'catalog' | 'local';
  /** The catalog scene's id, or the Stash scene's id. */
  @Input({ required: true }) sceneId!: string;

  protected readonly bodyId = `scene-evidence-${nextId++}`;
  protected readonly open = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly evidence = signal<SceneEvidence | null>(null);
  protected readonly copied = signal(false);
  protected readonly copyFailed = signal(false);

  ngOnChanges(changes: SimpleChanges): void {
    // Another scene: forget what was seen; look again if it's open.
    const change = changes['sceneId'] ?? changes['kind'];
    if (change && !change.firstChange) {
      this.evidence.set(null);
      if (this.open()) {
        this.load();
      }
    }
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
    if (this.copiedTimer) {
      clearTimeout(this.copiedTimer);
    }
  }

  /** Opens the panel and brings it into view (the timeline's "Details"). */
  reveal(): void {
    if (!this.open()) {
      this.toggle();
    }
    this.host.nativeElement.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  protected toggle(): void {
    this.open.update((value) => !value);
    if (this.open() && !this.evidence() && !this.loading()) {
      this.load();
    }
  }

  protected load(): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.copied.set(false);
    this.copyFailed.set(false);
    const lookup =
      this.kind === 'local'
        ? this.api.localScene(this.sceneId)
        : this.api.catalogScene(this.sceneId);
    this.request = lookup.subscribe({
      next: (evidence) => {
        this.evidence.set(evidence);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(
          'Couldn’t ask Stashboard what it sees. Check that it’s running and try again.',
        );
        this.loading.set(false);
      },
    });
  }

  protected async copy(): Promise<void> {
    const evidence = this.evidence();
    if (!evidence) {
      return;
    }
    try {
      await navigator.clipboard.writeText(evidenceText(evidence));
      this.copyFailed.set(false);
      this.copied.set(true);
      if (this.copiedTimer) {
        clearTimeout(this.copiedTimer);
      }
      this.copiedTimer = setTimeout(() => this.copied.set(false), COPIED_MS);
    } catch {
      this.copyFailed.set(true);
    }
  }

  protected formatCheckedAt(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }
}
