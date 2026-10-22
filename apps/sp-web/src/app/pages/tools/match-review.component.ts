import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  MatchCandidate,
  MatchConfidence,
  MatchProposal,
  OrganizerApiService,
  OrganizerRun,
} from '../../core/api/organizer.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

const CONFIDENCE: Record<MatchConfidence, string> = {
  exact: 'Same video',
  strong: 'Very likely',
  likely: 'Possible',
  weak: 'Unlikely',
};

/** Tags shown before "+N more". */
const TAGS_SHOWN = 8;

/**
 * The matches "Match all" found, waiting for you: nothing is saved until you
 * tick it here, so a wrong guess never reaches Stash.
 */
@Component({
  selector: 'app-match-review',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './match-review.component.html',
  styleUrls: ['./tools-shared.scss', './match-review.component.scss'],
})
export class MatchReviewComponent implements OnChanges {
  private readonly api = inject(OrganizerApiService);
  private readonly notifications = inject(AppNotificationsService);

  /** Changes whenever a run finishes, so the list is read again. */
  @Input() reloadKey = 0;
  /** Another organizer run is going: saving waits for it. */
  @Input() busy = false;
  /** Saving started a run on the server; the page follows it. */
  @Output() readonly started = new EventEmitter<OrganizerRun>();

  protected readonly confidenceLabel = CONFIDENCE;
  protected readonly proposals = signal<MatchProposal[]>([]);
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  protected readonly working = signal(false);
  /** Scenes whose whole tag list is open. */
  private readonly allTags = signal<ReadonlySet<string>>(new Set());
  protected readonly pickedCount = computed(() => this.picked().size);
  protected readonly exactCount = computed(
    () => this.proposals().filter((entry) => entry.match.confidence === 'exact').length,
  );

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['reloadKey']) {
      this.load();
    }
  }

  protected isPicked(sceneId: string): boolean {
    return this.picked().has(sceneId);
  }

  protected toggle(sceneId: string): void {
    this.picked.update((current) => {
      const next = new Set(current);
      if (!next.delete(sceneId)) {
        next.add(sceneId);
      }
      return next;
    });
  }

  protected pickAll(): void {
    this.picked.set(new Set(this.proposals().map((entry) => entry.scene.id)));
  }

  protected pickExact(): void {
    this.picked.set(
      new Set(
        this.proposals()
          .filter((entry) => entry.match.confidence === 'exact')
          .map((entry) => entry.scene.id),
      ),
    );
  }

  protected pickNone(): void {
    this.picked.set(new Set());
  }

  protected save(sceneIds: string[] = [...this.picked()]): void {
    if (sceneIds.length === 0 || this.working()) {
      return;
    }
    this.working.set(true);
    this.api.saveProposals(sceneIds).subscribe({
      next: (run) => {
        this.working.set(false);
        this.drop(sceneIds);
        this.started.emit(run);
      },
      error: (error: { error?: { message?: string } }) => {
        this.working.set(false);
        this.notifications.error(
          'Couldn’t save the matches',
          error?.error?.message ?? 'Try again in a moment.',
        );
      },
    });
  }

  protected dismiss(sceneIds: string[] = [...this.picked()]): void {
    if (sceneIds.length === 0 || this.working()) {
      return;
    }
    this.working.set(true);
    this.api.dismissProposals(sceneIds).subscribe({
      next: () => {
        this.working.set(false);
        this.drop(sceneIds);
      },
      error: () => {
        this.working.set(false);
        this.notifications.error('Couldn’t dismiss them', 'Try again in a moment.');
      },
    });
  }

  /** The performers to show: with photos when the source sent them. */
  protected castOf(match: MatchCandidate): Array<{ name: string; imageUrl: string | null }> {
    return match.cast ?? match.performers.map((name) => ({ name, imageUrl: null }));
  }

  protected shownTags(proposal: MatchProposal): string[] {
    const tags = proposal.match.tags ?? [];
    return this.allTags().has(proposal.scene.id) ? tags : tags.slice(0, TAGS_SHOWN);
  }

  protected showAllTags(sceneId: string): void {
    this.allTags.update((current) => new Set([...current, sceneId]));
  }

  /** Swaps in one of the alternatives; it's saved only when you save. */
  protected choose(proposal: MatchProposal, candidateId: string): void {
    if (this.working()) {
      return;
    }
    this.working.set(true);
    this.api.chooseProposal(proposal.scene.id, candidateId).subscribe({
      next: (updated) => {
        this.working.set(false);
        this.proposals.update((list) =>
          list.map((entry) => (entry.scene.id === updated.scene.id ? updated : entry)),
        );
      },
      error: (error: { error?: { message?: string } }) => {
        this.working.set(false);
        this.notifications.error(
          'Couldn’t switch the match',
          error?.error?.message ?? 'Try again in a moment.',
        );
      },
    });
  }

  protected folderOf(proposal: MatchProposal): string {
    return proposal.scene.folder;
  }

  private drop(sceneIds: string[]): void {
    const gone = new Set(sceneIds);
    this.proposals.update((list) => list.filter((entry) => !gone.has(entry.scene.id)));
    this.picked.update((current) => new Set([...current].filter((id) => !gone.has(id))));
  }

  private load(): void {
    this.api.proposals().subscribe({
      next: (list) => {
        this.proposals.set(list);
        const ids = new Set(list.map((entry) => entry.scene.id));
        this.picked.update((current) => new Set([...current].filter((id) => ids.has(id))));
      },
      error: () => undefined,
    });
  }
}
