import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Observable, firstValueFrom } from 'rxjs';
import {
  LocalLibraryService,
  ProblemKind,
  ProblemList,
  ProblemScene,
} from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

type FixAction = 'scan' | 'generate' | 'remove' | 'delete-files';

interface Fix {
  action: FixAction;
  label: string;
  /** Removing or deleting asks for a second tap. */
  confirm?: string;
}

interface ProblemInfo {
  title: string;
  why: string;
  fixes: Fix[];
}

const GENERATE: Fix = { action: 'generate', label: 'Generate' };

export const PROBLEMS: Record<ProblemKind, ProblemInfo> = {
  // Clean doesn't remove scenes with no file, and a library-wide Clean can
  // remove scenes on a drive that isn't mounted: they're removed one by one.
  'no-file': {
    title: 'Scenes with no file',
    why: 'Stash keeps a scene when its file goes. Remove them from Stash, or open one to give it a file again.',
    fixes: [{ action: 'remove', label: 'Remove from Stash', confirm: 'Tap again to remove' }],
  },
  'no-length': {
    title: 'Files that read as 0 seconds',
    why: 'Usually a damaged or unfinished download. Scan again in case Stash misread them; if they stay, delete them and get them again.',
    fixes: [
      { action: 'scan', label: 'Scan again' },
      { action: 'delete-files', label: 'Delete the files', confirm: 'Tap again to delete' },
    ],
  },
  'no-cover': {
    title: 'Scenes without a cover',
    why: 'Generate hasn’t made their picture yet.',
    fixes: [GENERATE],
  },
  'no-fingerprint': {
    title: 'Scenes without a fingerprint',
    why: 'Without one, Duplicates can’t find their copies. Generate makes it.',
    fixes: [GENERATE],
  },
  'no-marker-preview': {
    title: 'Chapters without a preview clip',
    why: 'Generate hasn’t made the clip that plays for these chapters. The count is chapters, the list is their scenes.',
    fixes: [GENERATE],
  },
};

/** Up to this many listed scenes get Generate for themselves; more runs it for the library. */
const GENERATE_FOR_LISTED = 50;

/**
 * What's wrong in the library, by kind, with the fix for each: a scan,
 * Generate, or removing what can't be fixed. Nothing runs until you press it,
 * and removing or deleting takes a second tap.
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
  private readonly destroyRef = inject(DestroyRef);
  private poll: ReturnType<typeof setTimeout> | null = null;
  private polls = 0;

  protected readonly lists = signal<ProblemList[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  /** "kind:action" pairs started since the list was last read. */
  protected readonly started = signal<Set<string>>(new Set());
  protected readonly confirming = signal<string | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly info = PROBLEMS;

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => this.stopPolling());
    this.load();
  }

  /** `refresh`: Look again also checks every chapter's clip afresh. */
  protected load(refresh = false): void {
    this.stopPolling();
    this.polls = 0;
    this.loading.set(true);
    this.error.set(false);
    this.library.problems(refresh).subscribe({
      next: (lists) => {
        // Fresh results: anything still listed can be fixed again.
        this.started.set(new Set());
        this.confirming.set(null);
        this.lists.set(lists);
        this.loading.set(false);
        this.pollWhileChecking(lists);
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
      },
    });
  }

  protected allClear(): boolean {
    return this.lists().every((list) => list.count === 0 && !list.checking);
  }

  /** The chapter check runs in Stashboard's background: ask again until it's done. */
  private pollWhileChecking(lists: ProblemList[]): void {
    if (!lists.some((list) => list.checking) || this.polls >= 120) {
      return;
    }
    this.polls += 1;
    this.poll = setTimeout(() => {
      this.library.problems().subscribe({
        next: (fresh) => {
          // Only the checked list changes; fixes started on the others stay.
          this.lists.set(fresh);
          this.pollWhileChecking(fresh);
        },
        error: () => this.pollWhileChecking(lists),
      });
    }, 5000);
  }

  private stopPolling(): void {
    if (this.poll) {
      clearTimeout(this.poll);
      this.poll = null;
    }
  }

  protected currentUrl(): string {
    return this.router.url;
  }

  protected key(list: ProblemList, fix: Fix): string {
    return `${list.kind}:${fix.action}`;
  }

  protected label(list: ProblemList, fix: Fix): string {
    const key = this.key(list, fix);
    if (this.busy() === key) {
      return 'Working…';
    }
    if (this.started().has(key)) {
      return fix.action === 'remove' || fix.action === 'delete-files' ? 'Done' : 'Started';
    }
    return this.confirming() === key && fix.confirm ? fix.confirm : fix.label;
  }

  protected async runFix(list: ProblemList, fix: Fix): Promise<void> {
    const key = this.key(list, fix);
    if (fix.confirm && this.confirming() !== key) {
      this.confirming.set(key);
      return;
    }
    this.confirming.set(null);
    if (fix.action === 'remove' || fix.action === 'delete-files') {
      // After a failure the button stays, to try the rest again. (Scenes
      // skipped for having more than one file would only be skipped again.)
      if (await this.removeListed(list, fix.action === 'delete-files')) {
        this.started.update((set) => new Set(set).add(key));
      }
      return;
    }
    // Every affected scene listed: Generate for just them. More: for the library
    // (Stash skips what it has already made).
    const everyScene =
      list.kind === 'no-marker-preview'
        ? list.scenes.length < GENERATE_FOR_LISTED
        : (list.count ?? 0) <= GENERATE_FOR_LISTED;
    const run: Observable<{ jobId: string | null }> =
      fix.action === 'generate' && everyScene
        ? this.library.generateFor(list.scenes.map((scene) => scene.id))
        : this.library.startJob(fix.action === 'scan' ? 'scan' : 'generate');
    run.subscribe({
      next: () => {
        this.started.update((set) => new Set(set).add(key));
        this.notifications.success(
          'Started in Stash',
          'Follow it in Library tools → Stash jobs, then Look again.',
        );
      },
      error: () =>
        this.notifications.error("Couldn't start it", 'Check that Stash is running and try again.'),
    });
  }

  /**
   * One at a time. Deleting files skips a scene with more than one file,
   * whose other files would go too.
   */
  /** False when one failed and the rest weren't tried. */
  private async removeListed(list: ProblemList, deleteFiles: boolean): Promise<boolean> {
    const key = `${list.kind}:${deleteFiles ? 'delete-files' : 'remove'}`;
    this.busy.set(key);
    const done = new Set<string>();
    const skipped = deleteFiles ? list.scenes.filter((scene) => (scene.fileCount ?? 1) > 1) : [];
    let failed: ProblemScene | null = null;
    for (const scene of list.scenes) {
      if (skipped.includes(scene)) {
        continue;
      }
      try {
        await firstValueFrom(this.library.deleteScene(scene.id, deleteFiles, deleteFiles));
        done.add(scene.id);
      } catch {
        failed = scene;
        break;
      }
    }
    this.busy.set(null);
    this.lists.update((lists) =>
      lists.map((entry) =>
        entry.kind === list.kind
          ? {
              ...entry,
              count: Math.max(0, (entry.count ?? 0) - done.size),
              scenes: entry.scenes.filter((scene) => !done.has(scene.id)),
            }
          : entry,
      ),
    );
    if (done.size > 0) {
      this.notifications.success(
        deleteFiles ? 'Deleted' : 'Removed from Stash',
        `${done.size} ${done.size === 1 ? 'scene' : 'scenes'}${deleteFiles ? ', files and all' : ''}.`,
      );
    }
    if (skipped.length > 0) {
      this.notifications.info(
        `${skipped.length} left in place`,
        'Those scenes have more than one file; deleting would delete them all. Open them in Stash instead.',
      );
    }
    if (failed) {
      this.notifications.error(
        "Couldn't remove them all",
        `Stopped at ${failed.title}. Check that Stash is running and try again.`,
      );
    }
    return failed === null;
  }
}
