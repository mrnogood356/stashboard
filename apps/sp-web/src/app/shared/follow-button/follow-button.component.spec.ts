import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
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

  it('follows on tap and opens its options', async () => {
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
    expect(root.querySelector('[data-testid="follow-panel"]')).toBeTruthy();
  });

  it('turns on automatic requests and unfollows from its options', async () => {
    const update = vi.fn().mockReturnValue(of(follow({ autoRequest: true })));
    const unfollow = vi.fn().mockReturnValue(of(undefined));
    const fixture = await render({
      lookup: vi.fn().mockReturnValue(of({ follow: follow({ newCount: 3 }), followable: true })),
      update,
      unfollow,
    });
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector('[data-testid="follow-toggle"]') as HTMLButtonElement;
    expect(toggle.textContent).toContain('3');

    toggle.click();
    fixture.detectChanges();
    const auto = root.querySelector('[data-testid="follow-auto"]') as HTMLInputElement;
    auto.checked = true;
    auto.dispatchEvent(new Event('change'));
    expect(update).toHaveBeenCalledWith('f1', { autoRequest: true });

    (root.querySelector('[data-testid="unfollow"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(unfollow).toHaveBeenCalledWith('f1');
    expect(toggle.textContent).not.toContain('Following');
  });

  it('isn’t offered on a secondary catalog’s page', async () => {
    const fixture = await render({
      lookup: vi.fn().mockReturnValue(of({ follow: null, followable: false })),
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="follow-toggle"]'),
    ).toBeNull();
  });
});
