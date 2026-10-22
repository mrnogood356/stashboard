import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FixCounts, LocalLibraryService, StashJob } from '../../core/api/local-library.service';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';

/** Library tools: fix-my-library, duplicates and Stash jobs, with a quick status. */
@Component({
  selector: 'app-tools-page',
  imports: [RouterLink],
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
    this.library
      .fixCounts()
      .subscribe({ next: (counts) => this.counts.set(counts), error: () => undefined });
    this.library.jobs().subscribe({ next: (jobs) => this.jobs.set(jobs), error: () => undefined });
  }

  protected toFix(counts: FixCounts): number {
    return counts.unmatched + counts.untagged + counts.unorganized;
  }
}
