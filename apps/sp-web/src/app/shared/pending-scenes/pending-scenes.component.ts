import { Component, DestroyRef, Input, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, defer, of, switchMap } from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { PendingScene } from '../../core/api/discover.types';

/**
 * New scenes someone sent to the catalog for this studio or performer that
 * it hasn't accepted yet. Each opens the edit on the catalog's site; they can
 * be requested once accepted. Shows nothing when there are none.
 */
@Component({
  selector: 'app-pending-scenes',
  templateUrl: './pending-scenes.component.html',
  styleUrl: './pending-scenes.component.scss',
})
export class PendingScenesComponent {
  private readonly discover = inject(DiscoverService);
  private readonly requests = new Subject<{ kind: 'studio' | 'performer'; id: string }>();
  private current = '';

  @Input({ required: true }) kind!: 'studio' | 'performer';

  /** A new studio or performer (the page is reused between them) starts over. */
  @Input({ required: true })
  set targetId(value: string) {
    const id = value.trim();
    if (!id || `${this.kind}:${id}` === this.current) {
      return;
    }
    this.current = `${this.kind}:${id}`;
    this.scenes.set([]);
    this.total.set(0);
    this.open.set(false);
    this.requests.next({ kind: this.kind, id });
  }

  protected readonly scenes = signal<PendingScene[]>([]);
  protected readonly total = signal(0);
  /** Folded at first: the accepted scenes come first. */
  protected readonly open = signal(false);

  constructor() {
    this.requests
      .pipe(
        switchMap(({ kind, id }) =>
          // Any failure, even one thrown straight away, just leaves the section out.
          defer(() =>
            kind === 'studio'
              ? this.discover.getStudioPendingScenes(id)
              : this.discover.getPerformerPendingScenes(id),
          ).pipe(catchError(() => of({ total: 0, items: [] }))),
        ),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(({ total, items }) => {
        this.scenes.set(items);
        this.total.set(Math.max(total, items.length));
      });
  }

  protected details(scene: PendingScene): string {
    return [scene.date, scene.performers.slice(0, 2).join(', ')].filter(Boolean).join(' · ');
  }

  protected votes(scene: PendingScene): string {
    return scene.votes === 1 ? '1 vote' : `${scene.votes} votes`;
  }
}
