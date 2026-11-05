import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, debounceTime } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LocalLibraryService, type Chapter } from '../../core/api/local-library.service';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';
import { PlayQueueService, shuffled } from '../../core/play-queue/play-queue.service';
import { ClipPreviewComponent } from '../../shared/scene-card/clip-preview.component';
import { SectionBackComponent } from '../../shared/section-back/section-back.component';
import { formatTime } from '../watch/player.utils';

/**
 * Chapter playlists: chapters from across the library, by tag, performer or
 * words, played back to back in order or shuffled.
 */
@Component({
  selector: 'app-chapters-page',
  imports: [FormsModule, ClipPreviewComponent, SectionBackComponent],
  templateUrl: './chapters-page.component.html',
  styleUrl: './chapters-page.component.scss',
})
export class ChaptersPageComponent implements OnInit {
  private readonly library = inject(LocalLibraryService);
  private readonly queue = inject(PlayQueueService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly previewsOn = inject(PlaybackSettingsService).previewsEnabled;

  protected readonly tags = signal<Array<{ id: string; name: string; count: number }>>([]);
  protected readonly chapters = signal<Chapter[] | null>(null);
  protected readonly error = signal(false);
  protected readonly tag = signal<string | null>(null);
  /** From a performer's page: just their chapters. */
  protected readonly performer = signal<{ id: string; name: string } | null>(null);
  protected query = '';
  protected readonly formatTime = formatTime;
  private readonly typed = new Subject<void>();

  constructor() {
    this.typed.pipe(debounceTime(300), takeUntilDestroyed()).subscribe(() => this.load());
  }

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    const performerId = params.get('performer');
    if (performerId) {
      this.performer.set({ id: performerId, name: params.get('name') ?? 'This performer' });
    }
    this.tag.set(params.get('tag'));
    this.library.chapterTags().subscribe({
      next: (tags) => this.tags.set(tags),
      error: () => this.tags.set([]),
    });
    this.load();
  }

  protected pickTag(id: string | null): void {
    this.tag.set(this.tag() === id ? null : id);
    this.load();
  }

  protected clearPerformer(): void {
    this.performer.set(null);
    this.load();
  }

  protected onType(): void {
    this.typed.next();
  }

  protected length(chapter: Chapter): string {
    return formatTime(Math.max(0, chapter.endSeconds - chapter.seconds));
  }

  protected play(from = 0, shuffle = false): void {
    const list = this.chapters() ?? [];
    const ordered = shuffle ? shuffled(list) : list.slice(from);
    const tagName = this.tags().find((tag) => tag.id === this.tag())?.name;
    const label = this.performer()?.name ?? tagName ?? (this.query.trim() || 'Chapters');
    const first = this.queue.start({
      label: `Chapters: ${label}`,
      kind: 'chapters',
      items: ordered.map((chapter) => ({
        sceneId: chapter.sceneId,
        title: `${chapter.title} · ${chapter.sceneTitle}`,
        imageUrl: chapter.imageUrl,
        start: chapter.seconds,
        end: chapter.endSeconds,
      })),
    });
    if (first) {
      void this.router.navigate(['/watch', first.sceneId], {
        queryParams: { returnTo: this.router.url },
      });
    }
  }

  private load(): void {
    this.chapters.set(null);
    this.error.set(false);
    this.library
      .chapters({
        tag: this.tag() ?? undefined,
        performer: this.performer()?.id,
        q: this.query.trim() || undefined,
      })
      .subscribe({
        next: (chapters) => this.chapters.set(chapters),
        error: () => this.error.set(true),
      });
  }
}
