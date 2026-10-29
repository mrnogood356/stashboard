import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FixCounts, LocalLibraryService, StashJob } from '../../core/api/local-library.service';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';
import { SectionBackComponent } from '../../shared/section-back/section-back.component';

/** Library tools: fix-my-library, duplicates and Stash jobs, with a quick status. */
@Component({
  selector: 'app-tools-page',
  imports: [SectionBackComponent, RouterLink],
  templateUrl: './tools-page.component.html',
  styleUrls: ['./tools-shared.scss', './tools-page.component.scss'],
})
export class ToolsPageComponent implements OnInit {
  private readonly library = inject(LocalLibraryService);
  /** Settings → Playback: off hides the swipe feed. */
  protected readonly feedOn = inject(PlaybackSettingsService).feedEnabled;

  protected readonly counts = signal<FixCounts | null>(null);
  protected readonly jobs = signal<StashJob[] | null>(null);

  ngOnInit(): void {
    this.library.fixCounts().subscribe({
      // Only real numbers are shown; anything else keeps the plain description.
      next: (counts) =>
        this.counts.set(
          typeof counts?.unmatched === 'number' &&
            typeof counts.untagged === 'number' &&
            typeof counts.unorganized === 'number'
            ? counts
            : null,
        ),
      error: () => undefined,
    });
    this.library.jobs().subscribe({
      next: (jobs) => this.jobs.set(Array.isArray(jobs) ? jobs : null),
      error: () => undefined,
    });
  }

  protected toFix(counts: FixCounts): number {
    return counts.unmatched + counts.untagged + counts.unorganized;
  }
}
