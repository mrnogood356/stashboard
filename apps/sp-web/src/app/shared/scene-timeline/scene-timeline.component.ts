import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  SceneTimeline,
  TimelineAction,
  TimelineApiService,
  TimelineStepStatus,
  timelineTone,
} from '../../core/api/timeline.service';

const STATUS_TEXT: Record<TimelineStepStatus, string> = {
  done: 'Done',
  current: 'Now',
  failed: 'Stuck',
  skipped: 'Skipped',
  unknown: 'Unknown',
  next: 'Next',
};

const STATUS_ICON: Record<TimelineStepStatus, string> = {
  done: 'pi pi-check',
  current: 'pi pi-spinner',
  failed: 'pi pi-times',
  skipped: 'pi pi-minus',
  unknown: 'pi pi-question',
  next: 'pi pi-circle',
};

/** Where an action that's a page in Stashboard goes. */
const ACTION_LINK: Partial<Record<TimelineAction['kind'], string>> = {
  'check-matches': '/tools/organize',
  scan: '/tools/jobs',
  generate: '/tools/jobs',
};

/**
 * The story of a scene's request, as a short vertical list of steps:
 * where it's been, where it is now (or stuck, with what to do), and what's
 * next. Only asks the server once it scrolls into view. "Details" opens
 * the raw facts ("Why is it like this?").
 */
@Component({
  selector: 'app-scene-timeline',
  imports: [RouterLink],
  templateUrl: './scene-timeline.component.html',
  styleUrl: './scene-timeline.component.scss',
})
export class SceneTimelineComponent implements OnChanges, AfterViewInit, OnDestroy {
  private readonly api = inject(TimelineApiService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private request: Subscription | null = null;
  private observer: IntersectionObserver | null = null;
  private visible = false;

  /** The catalog (StashDB/FansDB) scene's id. */
  @Input({ required: true }) stashId!: string;
  /** Its own panel with a heading (scene page); off inside a card. */
  @Input() heading = true;
  /** Wait until it's scrolled into view; off when it was just opened by a tap. */
  @Input() lazy = true;
  /** For "Open it in Whisparr". */
  @Input() whisparrUrl: string | null = null;
  /** "Details" was tapped: show the raw facts. */
  @Output() readonly details = new EventEmitter<void>();
  /** An action the page handles itself (picking a release). */
  @Output() readonly act = new EventEmitter<TimelineAction>();

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly timeline = signal<SceneTimeline | null>(null);
  protected readonly actionLink = ACTION_LINK;

  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['stashId'];
    if (change && !change.firstChange) {
      this.timeline.set(null);
      if (this.visible) {
        this.load();
      }
    }
  }

  ngAfterViewInit(): void {
    // Lazily: only once it's on screen (or straight away without the API).
    if (!this.lazy || typeof IntersectionObserver === 'undefined') {
      this.becameVisible();
      return;
    }
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.observer?.disconnect();
        this.observer = null;
        this.becameVisible();
      }
    });
    this.observer.observe(this.host.nativeElement);
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
    this.observer?.disconnect();
  }

  protected load(): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.request = this.api.scene(this.stashId).subscribe({
      next: (timeline) => {
        this.timeline.set(timeline);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(
          'Couldn’t get the timeline. Check that Stashboard is running and try again.',
        );
        this.loading.set(false);
      },
    });
  }

  protected tone(timeline: SceneTimeline): string {
    return timelineTone(timeline);
  }

  protected statusText(status: TimelineStepStatus): string {
    return STATUS_TEXT[status];
  }

  protected icon(status: TimelineStepStatus): string {
    return STATUS_ICON[status];
  }

  protected when(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
  }

  protected unknownNote(timeline: SceneTimeline): string {
    const names = timeline.unknown;
    const list =
      names.length > 1
        ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
        : names[0];
    return `Couldn’t ask ${list}, so some steps are unknown.`;
  }

  private becameVisible(): void {
    this.visible = true;
    if (!this.timeline() && !this.loading()) {
      this.load();
    }
  }
}
