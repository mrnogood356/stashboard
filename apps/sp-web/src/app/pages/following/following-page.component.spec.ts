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

  it('lists each follow as a row that opens its options', async () => {
    const fixture = await render({
      list: vi.fn().mockReturnValue(
        of({
          follows: [follow, { ...follow, id: 'f2', entityId: 'p2', name: 'Other', newCount: 0 }],
          checking: false,
          provider: 'STASHDB',
        }),
      ),
      releases: vi.fn().mockReturnValue(of({ items: [], reviewCount: 0 })),
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('You’re all caught up');

    (root.querySelector('[data-testid="tab-manage"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const row = root.querySelector('[data-testid="follow-p1"]') as HTMLButtonElement;
    expect(row.textContent).toContain('2 new');
    expect(root.querySelector('[data-testid="follow-p2"]')?.textContent).toContain(
      'Every new scene',
    );
    // No controls in the row itself.
    expect(row.querySelector('select, input')).toBeNull();

    row.click();
    fixture.detectChanges();
    expect(document.querySelector('[data-testid="follow-sheet"]')?.textContent).toContain(
      'Following Kaitlyn',
    );
  });

  it('updates a row saved from its sheet, and drops one unfollowed', async () => {
    const releases = vi.fn().mockReturnValue(of({ items: [], reviewCount: 0 }));
    const fixture = await render({
      list: vi
        .fn()
        .mockReturnValue(of({ follows: [follow], checking: false, provider: 'STASHDB' })),
      releases,
    });
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[data-testid="tab-manage"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const page = fixture.componentInstance as unknown as {
      onSheetSaved(follow: Follow, changes: object): void;
      onUnfollowed(follow: Follow): void;
    };

    page.onSheetSaved({ ...follow, autoRequest: true }, { autoRequest: true });
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="follow-p1"]')?.textContent).toContain(
      'Requests automatically',
    );

    page.onUnfollowed(follow);
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="follow-p1"]')).toBeNull();
  });

  it('reads each row out in full, and moves focus on when one is unfollowed', async () => {
    const fixture = await render({
      list: vi.fn().mockReturnValue(
        of({
          follows: [follow, { ...follow, id: 'f2', entityId: 'p2', name: 'Other', newCount: 0 }],
          checking: false,
          provider: 'STASHDB',
        }),
      ),
      releases: vi.fn().mockReturnValue(of({ items: [], reviewCount: 0 })),
    });
    const root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    (root.querySelector('[data-testid="tab-manage"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const row = root.querySelector('[data-testid="follow-p1"]') as HTMLButtonElement;
    // Its name is its text: who, what's new and when it was checked.
    expect(row.hasAttribute('aria-label')).toBe(false);

    row.focus();
    (fixture.componentInstance as unknown as { onUnfollowed(f: Follow): void }).onUnfollowed(
      follow,
    );
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute('data-testid')).toBe('follow-p2'),
    );
    root.remove();
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
