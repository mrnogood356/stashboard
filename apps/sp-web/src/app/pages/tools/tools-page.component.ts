import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FixCounts, LocalLibraryService, StashJob } from '../../core/api/local-library.service';
import { SectionBackComponent } from '../../shared/section-back/section-back.component';

/** Stash's job states for jobs that are over. */
const ENDED = new Set(['FINISHED', 'CANCELLED', 'FAILED']);

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

  /** Running and waiting jobs; Stash also lists ones that just finished. */
  private readonly jobCounts = computed(() => {
    const jobs = this.jobs();
    if (jobs === null) {
      return null;
    }
    const running = jobs.filter((job) => job.status === 'RUNNING').length;
    const waiting = jobs.filter((job) => !ENDED.has(job.status) && job.status !== 'RUNNING').length;
    return { running, waiting };
  });

  protected readonly jobsText = computed(() => {
    const counts = this.jobCounts();
    if (!counts) {
      return '–';
    }
    return counts.running > 0
      ? `${counts.running} running`
      : counts.waiting > 0
        ? `${counts.waiting} waiting`
        : 'Idle';
  });

  /** "2 jobs running · 1 waiting", "Stash is idle". */
  protected readonly jobsDetail = computed(() => {
    const counts = this.jobCounts();
    if (!counts) {
      return null;
    }
    const { running, waiting } = counts;
    if (running === 0 && waiting === 0) {
      return 'Stash is idle';
    }
    if (running === 0) {
      return `${waiting} ${waiting === 1 ? 'job' : 'jobs'} waiting`;
    }
    const text = `${running} ${running === 1 ? 'job' : 'jobs'} running`;
    return waiting > 0 ? `${text} · ${waiting} waiting` : text;
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
