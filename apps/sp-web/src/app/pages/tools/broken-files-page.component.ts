import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import {
  LibraryTask,
  LocalLibraryService,
  ProblemKind,
  ProblemList,
} from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

interface ProblemInfo {
  title: string;
  why: string;
  /** No fix button when there's no safe one-tap fix. */
  fix: string | null;
  /** A Stash job for the whole library, or Generate for just these scenes. */
  action: 'scan' | 'generate' | null;
}

export const PROBLEMS: Record<ProblemKind, ProblemInfo> = {
  // Clean doesn't remove scenes with no file, and a library-wide Clean can
  // remove scenes on a drive that isn't mounted: no button here.
  'no-file': {
    title: 'Scenes with no file',
    why: 'Stash keeps a scene when its file goes. Open each one to delete it, or to give it a file again.',
    fix: null,
    action: null,
  },
  'no-length': {
    title: 'Files that read as 0 seconds',
    why: 'Usually a damaged or unfinished download. A scan reads them again; if they stay here, open one to check it plays, and remove it if it doesn’t.',
    fix: 'Scan again',
    action: 'scan',
  },
  'no-cover': {
    title: 'Scenes without a cover',
    why: 'Generate hasn’t made their picture yet.',
    fix: 'Generate',
    action: 'generate',
  },
  'no-fingerprint': {
    title: 'Scenes without a fingerprint',
    why: 'Without one, Duplicates can’t find their copies. Generate makes it.',
    fix: 'Generate',
    action: 'generate',
  },
};

/** Up to this many listed scenes get Generate for themselves; more runs it for the library. */
const GENERATE_FOR_LISTED = 50;

/**
 * What's wrong in the library, by kind, with the one fix for each: Clean,
 * a scan, or Generate. Nothing runs until you press it.
 */
@Component({
  selector: 'app-broken-files-page',
  imports: [RouterLink],
  templateUrl: './broken-files-page.component.html',
  styleUrls: ['./tools-shared.scss', './broken-files-page.component.scss'],
})
export class BrokenFilesPageComponent implements OnInit {
  private readonly library = inject(LocalLibraryService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly router = inject(Router);

  protected readonly lists = signal<ProblemList[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly started = signal<Set<ProblemKind>>(new Set());
  protected readonly info = PROBLEMS;

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.library.problems().subscribe({
      next: (lists) => {
        // Fresh results: anything still listed can be fixed again.
        this.started.set(new Set());
        this.lists.set(lists);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
      },
    });
  }

  protected allClear(): boolean {
    return this.lists().every((list) => list.count === 0);
  }

  protected currentUrl(): string {
    return this.router.url;
  }

  protected fix(list: ProblemList): void {
    const info = PROBLEMS[list.kind];
    if (!info.action) {
      return;
    }
    let run: Observable<{ jobId: string | null }>;
    if (info.action === 'generate' && (list.count ?? 0) <= GENERATE_FOR_LISTED) {
      run = this.library.generateFor(list.scenes.map((scene) => scene.id));
    } else {
      run = this.library.startJob(info.action satisfies LibraryTask);
    }
    run.subscribe({
      next: () => {
        this.started.update((set) => new Set(set).add(list.kind));
        this.notifications.success(
          'Started in Stash',
          'Follow it in Library tools → Stash jobs, then look here again.',
        );
      },
      error: () =>
        this.notifications.error("Couldn't start it", 'Check that Stash is running and try again.'),
    });
  }
}
