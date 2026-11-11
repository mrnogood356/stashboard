import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { Follow, FollowedRelease, FollowsApiService } from '../../core/api/follows.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { FollowingPageComponent } from './following-page.component';

const release = (id: string, overrides: Partial<FollowedRelease['followed']> = {}) =>
  ({
    id,
    title: `Scene ${id}`,
    description: null,
    imageUrl: null,
    cardImageUrl: null,
    studioId: 'st',
    studio: 'Studio',
    studioImageUrl: null,
    releaseDate: '2026-11-10',
    duration: 1800,
    type: 'SCENE',
    source: 'STASHDB',
    status: { state: 'NOT_REQUESTED' },
    requestable: true,
    localSceneId: null,
    followed: {
      state: 'NEW',
      detail: null,
      foundAt: '2026-11-11T06:15:00.000Z',
      follows: [{ id: 'f1', kind: 'PERFORMER', entityId: 'p1', name: 'Kaitlyn' }],
      ...overrides,
    },
  }) as FollowedRelease;

const follow: Follow = {
  id: 'f1',
  kind: 'PERFORMER',
  provider: 'STASHDB',
  entityId: 'p1',
  name: 'Kaitlyn',
  imageUrl: null,
  since: '2026-11-11',
  autoRequest: false,
  tags: [],
  lastCheckedAt: '2026-11-11T06:15:00.000Z',
  lastError: null,
  newCount: 2,
  createdAt: '2026-11-11T06:00:00.000Z',
};

describe('FollowingPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(api: Partial<FollowsApiService>) {
    await TestBed.configureTestingModule({
      imports: [FollowingPageComponent],
      providers: [
        provideRouter([]),
        { provide: FollowsApiService, useValue: api },
        { provide: AppNotificationsService, useValue: { error: vi.fn(), success: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(FollowingPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('lists new scenes with who they’re from, and Not interested removes one', async () => {
    const dismiss = vi.fn().mockReturnValue(of(undefined));
    const fixture = await render({
      list: vi
        .fn()
        .mockReturnValue(of({ follows: [follow], checking: false, provider: 'STASHDB' })),
      releases: vi.fn().mockReturnValue(
        of({
          items: [release('a'), release('b', { state: 'FAILED', detail: 'Whisparr is down' })],
          reviewCount: 2,
        }),
      ),
      dismiss,
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="tab-new"]')?.textContent).toContain('2');
    expect(root.textContent).toContain('Kaitlyn');
    expect(root.textContent).toContain('Couldn’t request it automatically: Whisparr is down');

    (root.querySelector('[data-testid="dismiss"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(dismiss).toHaveBeenCalledWith('a');
    expect(root.querySelector('[data-testid="release-a"]')).toBeNull();
    expect(root.querySelector('[data-testid="tab-new"]')?.textContent).toContain('1');
  });

  it('manages follows on their own tab', async () => {
    const update = vi.fn().mockReturnValue(of({ ...follow, autoRequest: true }));
    const fixture = await render({
      list: vi
        .fn()
        .mockReturnValue(of({ follows: [follow], checking: false, provider: 'STASHDB' })),
      releases: vi.fn().mockReturnValue(of({ items: [], reviewCount: 0 })),
      update,
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('You’re all caught up');

    (root.querySelector('[data-testid="tab-manage"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="follow-p1"]')?.textContent).toContain('2 new');
    const auto = root.querySelector('[data-testid="auto-p1"]') as HTMLInputElement;
    auto.checked = true;
    auto.dispatchEvent(new Event('change'));
    expect(update).toHaveBeenCalledWith('f1', { autoRequest: true });
  });

  it('points to performers when nobody is followed yet', async () => {
    const fixture = await render({
      list: vi.fn().mockReturnValue(of({ follows: [], checking: false, provider: 'STASHDB' })),
      releases: vi.fn().mockReturnValue(of({ items: [], reviewCount: 0 })),
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('You’re not following anyone yet');
    expect((root.querySelector('[data-testid="check-now"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('narrows a follow to tags from its row', async () => {
    const anal = { id: 't-anal', name: 'Anal' };
    const update = vi.fn().mockReturnValue(of({ ...follow, tags: [anal] }));
    const fixture = await render({
      list: vi
        .fn()
        .mockReturnValue(of({ follows: [follow], checking: false, provider: 'STASHDB' })),
      releases: vi.fn().mockReturnValue(of({ items: [], reviewCount: 0 })),
      searchTags: vi.fn().mockReturnValue(of([anal])),
      update,
    });
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[data-testid="tab-manage"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="follow-p1"]')?.textContent).toContain('Every tag');

    (root.querySelector('[data-testid="edit-tags-p1"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const search = root.querySelector('[data-testid="tag-search"]') as HTMLInputElement;
    search.value = 'an';
    search.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    fixture.detectChanges();
    (root.querySelector('[data-testid="add-tag-t-anal"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(update).toHaveBeenCalledWith('f1', { tags: [anal] });
    expect(root.querySelector('[data-testid="follow-p1"]')?.textContent).toContain(
      'Only tagged Anal',
    );
  });

  it('offers to try again when a list can’t be read', async () => {
    const releases = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('down')))
      .mockReturnValue(of({ items: [release('a')], reviewCount: 1 }));
    const fixture = await render({
      list: vi
        .fn()
        .mockReturnValue(of({ follows: [follow], checking: false, provider: 'STASHDB' })),
      releases,
    });
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[data-testid="retry-releases"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="release-a"]')).toBeTruthy();
  });

  it('keeps each follow’s controls waiting for its own save', async () => {
    const other: Follow = { ...follow, id: 'f2', entityId: 'p2', name: 'Other' };
    const saves = new Map<string, Subject<Follow>>([
      ['f1', new Subject<Follow>()],
      ['f2', new Subject<Follow>()],
    ]);
    const update = vi.fn((id: string) => saves.get(id)!);
    const fixture = await render({
      list: vi
        .fn()
        .mockReturnValue(of({ follows: [follow, other], checking: false, provider: 'STASHDB' })),
      releases: vi.fn().mockReturnValue(of({ items: [], reviewCount: 0 })),
      update,
    });
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[data-testid="tab-manage"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const check = (id: string) =>
      root.querySelector(`[data-testid="auto-${id}"]`) as HTMLInputElement;

    check('p1').click();
    check('p2').click();
    fixture.detectChanges();
    saves.get('f2')!.next({ ...other, autoRequest: true });
    saves.get('f2')!.complete();
    fixture.detectChanges();
    // p2 is saved; p1's save is still on its way, so it can't be changed yet.
    expect(check('p2').disabled).toBe(false);
    expect(check('p1').disabled).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('shows the newest list when an older one answers last', async () => {
    const older = new Subject<{ items: FollowedRelease[]; reviewCount: number }>();
    const releases = vi
      .fn()
      .mockReturnValueOnce(older)
      .mockReturnValue(of({ items: [release('new')], reviewCount: 1 }));
    const fixture = await render({
      list: vi
        .fn()
        .mockReturnValue(of({ follows: [follow], checking: false, provider: 'STASHDB' })),
      releases,
    });
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[data-testid="tab-recent"]') as HTMLButtonElement).click();
    (root.querySelector('[data-testid="tab-new"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    older.next({ items: [release('stale')], reviewCount: 9 });
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="release-stale"]')).toBeNull();
    expect(root.querySelector('[data-testid="release-new"]')).toBeTruthy();
  });
});
