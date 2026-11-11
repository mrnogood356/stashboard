import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { Follow, FollowsApiService } from '../../core/api/follows.service';
import { FollowSheetComponent } from './follow-sheet.component';

const follow = (overrides: Partial<Follow> = {}): Follow => ({
  id: 'f1',
  kind: 'PERFORMER',
  provider: 'STASHDB',
  entityId: 'p1',
  name: 'Kaitlyn',
  imageUrl: null,
  since: new Date().toISOString().slice(0, 10),
  autoRequest: false,
  tags: [{ id: 't-out', name: 'Outdoor' }],
  lastCheckedAt: null,
  lastError: null,
  newCount: 0,
  createdAt: '2026-11-11T10:00:00.000Z',
  ...overrides,
});

/** What the template binds to, for driving the sheet without PrimeNG's internals. */
interface SheetState {
  startChoice: { (): number | string; set(value: number | string): void };
  autoRequest: { (): boolean; set(value: boolean): void };
  onTagsChanged(ids: string[] | null): void;
  onTagFilter(value: string): void;
  tagOptions(): Array<{ label: string; value: string }>;
}

describe('FollowSheetComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(api: Partial<FollowsApiService>, value: Follow = follow()) {
    await TestBed.configureTestingModule({
      imports: [FollowSheetComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        { provide: FollowsApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(FollowSheetComponent);
    fixture.componentRef.setInput('follow', value);
    fixture.componentRef.setInput('open', true);
    const saved: unknown[] = [];
    const unfollowed: Follow[] = [];
    fixture.componentInstance.saved.subscribe((event) => saved.push(event));
    fixture.componentInstance.unfollowed.subscribe((event) => unfollowed.push(event));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const state = fixture.componentInstance as unknown as SheetState;
    const click = (testId: string) => {
      (document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click();
      fixture.detectChanges();
    };
    return { fixture, state, saved, unfollowed, click };
  }

  it('starts from what’s saved, and saves only what changed', async () => {
    const update = vi.fn().mockReturnValue(of(follow({ autoRequest: true })));
    const { state, saved, click } = await render({ update });
    expect(state.startChoice()).toBe(0);
    expect(state.autoRequest()).toBe(false);
    expect(document.querySelector('[data-testid="follow-sheet"]')?.textContent).toContain(
      'Following Kaitlyn',
    );

    state.autoRequest.set(true);
    click('follow-save');
    expect(update).toHaveBeenCalledWith('f1', { autoRequest: true });
    expect(saved).toEqual([
      { follow: follow({ autoRequest: true }), changes: { autoRequest: true } },
    ]);
  });

  it('saves a new start and tags found by searching', async () => {
    const anal = { id: 't-anal', name: 'Anal' };
    const update = vi.fn().mockReturnValue(of(follow()));
    const { state, click } = await render({
      update,
      searchTags: vi.fn().mockReturnValue(of([anal])),
    });
    state.onTagFilter('an');
    await vi.waitFor(() =>
      expect(state.tagOptions().map((option) => option.value)).toContain('t-anal'),
    );
    state.onTagsChanged(['t-out', 't-anal']);
    state.startChoice.set(30);
    click('follow-save');

    const [, changes] = update.mock.calls[0] as [string, { since: string; tags: unknown }];
    expect(changes.tags).toEqual([{ id: 't-out', name: 'Outdoor' }, anal]);
    expect(changes.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps a start none of the choices matches, unless another is picked', async () => {
    const update = vi.fn();
    const { state, click, fixture } = await render({ update }, follow({ since: '2020-01-02' }));
    expect(state.startChoice()).toBe('keep');
    // Nothing changed: Save just closes.
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    click('follow-save');
    expect(update).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
  });

  it('says when saving fails and keeps what was chosen', async () => {
    const { state, saved, click } = await render({
      update: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
    });
    state.autoRequest.set(true);
    click('follow-save');
    expect(saved).toEqual([]);
    expect(document.querySelector('[data-testid="follow-sheet"]')?.textContent).toContain(
      'Couldn’t save that',
    );
    expect(state.autoRequest()).toBe(true);
  });

  it('asks again before unfollowing', async () => {
    const unfollow = vi.fn().mockReturnValue(of(undefined));
    const { unfollowed, click } = await render({ unfollow });
    click('unfollow');
    expect(unfollow).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="unfollow"]')?.textContent).toContain('Tap again');
    click('unfollow');
    expect(unfollow).toHaveBeenCalledWith('f1');
    expect(unfollowed).toEqual([follow()]);
  });
});
