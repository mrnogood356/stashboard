import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FixCounts, LocalLibraryService, StashJob } from '../../core/api/local-library.service';
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
  protected readonly counts = signal<FixCounts | null>(null);
  protected readonly jobs = signal<StashJob[] | null>(null);

  protected readonly allClear = computed(() => {
    const counts = this.counts();
    return counts !== null && this.toFix(counts) === 0;
  });

  /**
   * The status card's heading. The counts overlap (one scene can be
   * unmatched and untagged), so they aren't added up.
   */
  protected readonly headline = computed(() => {
    const counts = this.counts();
    if (!counts) {
      return 'Your Stash library';
    }
    return this.toFix(counts) === 0 ? 'Your library is in good shape' : 'Some scenes need a look';
  });

  protected readonly jobsText = computed(() => {
    const jobs = this.jobs();
    return jobs === null ? '–' : jobs.length === 0 ? 'Idle' : `${jobs.length} running`;
  });

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
