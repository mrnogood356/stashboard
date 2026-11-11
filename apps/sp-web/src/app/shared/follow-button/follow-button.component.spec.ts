import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { Follow, FollowsApiService } from '../../core/api/follows.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { FollowButtonComponent } from './follow-button.component';

const follow = (overrides: Partial<Follow> = {}): Follow => ({
  id: 'f1',
  kind: 'PERFORMER',
  provider: 'STASHDB',
  entityId: 'p1',
  name: 'Kaitlyn',
  imageUrl: null,
  since: '2026-11-11',
  autoRequest: false,
  tags: [],
  lastCheckedAt: null,
  lastError: null,
  newCount: 0,
  createdAt: '2026-11-11T10:00:00.000Z',
  ...overrides,
});

describe('FollowButtonComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(api: Partial<FollowsApiService>) {
    await TestBed.configureTestingModule({
      imports: [FollowButtonComponent],
      providers: [
        provideRouter([]),
        { provide: FollowsApiService, useValue: api },
        { provide: AppNotificationsService, useValue: { error: vi.fn(), success: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(FollowButtonComponent);
    fixture.componentRef.setInput('kind', 'PERFORMER');
    fixture.componentRef.setInput('entityId', 'p1');
    fixture.componentRef.setInput('name', 'Kaitlyn');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('follows on tap, without opening anything', async () => {
    const followCall = vi.fn().mockReturnValue(of(follow()));
    const fixture = await render({
      lookup: vi.fn().mockReturnValue(of({ follow: null, followable: true })),
      follow: followCall,
    });
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector('[data-testid="follow-toggle"]') as HTMLButtonElement;
    expect(toggle.textContent).toContain('Follow');

    toggle.click();
    fixture.detectChanges();
    expect(followCall).toHaveBeenCalledWith({
      kind: 'PERFORMER',
      entityId: 'p1',
      name: 'Kaitlyn',
      imageUrl: null,
    });
    expect(toggle.textContent).toContain('Following');
    expect(document.querySelector('[data-testid="follow-sheet"]')).toBeNull();
  });

  it('opens the options sheet once followed, and shows what’s new', async () => {
    const fixture = await render({
      lookup: vi.fn().mockReturnValue(of({ follow: follow({ newCount: 3 }), followable: true })),
    });
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector('[data-testid="follow-toggle"]') as HTMLButtonElement;
    expect(toggle.textContent).toContain('3 new');
    expect(toggle.getAttribute('aria-haspopup')).toBe('dialog');

    toggle.click();
    fixture.detectChanges();
    expect(document.querySelector('[data-testid="follow-sheet"]')?.textContent).toContain(
      'Following Kaitlyn',
    );
  });

  it('isn’t offered on a secondary catalog’s page', async () => {
    const fixture = await render({
      lookup: vi.fn().mockReturnValue(of({ follow: null, followable: false })),
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="follow-toggle"]'),
    ).toBeNull();
  });

  it('ignores a follow that finishes after the page moved on', async () => {
    const pending = new Subject<Follow>();
    const lookup = vi
      .fn()
      .mockReturnValueOnce(of({ follow: null, followable: true }))
      .mockReturnValueOnce(of({ follow: null, followable: true }));
    const fixture = await render({ lookup, follow: vi.fn().mockReturnValue(pending) });
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[data-testid="follow-toggle"]') as HTMLButtonElement).click();

    // Now on another performer's page; then the first follow comes back.
    fixture.componentRef.setInput('entityId', 'p2');
    fixture.detectChanges();
    pending.next(follow());
    pending.complete();
    fixture.detectChanges();
    const toggle = root.querySelector('[data-testid="follow-toggle"]') as HTMLButtonElement;
    expect(toggle.textContent).not.toContain('Following');
    expect(toggle.disabled).toBe(false);
  });

  it('ignores a failed lookup for a page it has left', async () => {
    const first = new Subject<never>();
    const lookup = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(of({ follow: null, followable: true }));
    const fixture = await render({ lookup });
    fixture.componentRef.setInput('entityId', 'p2');
    fixture.detectChanges();
    first.error(new Error('slow and failed'));
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="follow-toggle"]'),
    ).toBeTruthy();
  });
});
