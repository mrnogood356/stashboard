import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { Suggestion, SuggestionsApiService } from '../../core/api/suggestions.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { YouMayEnjoyComponent } from './you-may-enjoy.component';

const suggestion = (id: string, reason: string): Suggestion =>
  ({
    id,
    title: `Scene ${id}`,
    description: null,
    imageUrl: null,
    cardImageUrl: null,
    studioId: 'st',
    studio: 'Studio',
    studioImageUrl: null,
    releaseDate: '2026-10-01',
    duration: 1800,
    type: 'SCENE',
    source: 'STASHDB',
    status: { state: 'NOT_REQUESTED' },
    requestable: true,
    localSceneId: null,
    reason: { key: `performer:${id}`, text: reason },
  }) as Suggestion;

describe('YouMayEnjoyComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(api: Partial<SuggestionsApiService>) {
    await TestBed.configureTestingModule({
      imports: [YouMayEnjoyComponent],
      providers: [
        provideRouter([]),
        { provide: SuggestionsApiService, useValue: api },
        { provide: AppNotificationsService, useValue: { error: vi.fn(), success: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(YouMayEnjoyComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('shows each scene with why it was picked, and Not interested hides it', async () => {
    const dismiss = vi.fn().mockReturnValue(of(undefined));
    const items = Array.from({ length: 10 }, (_, i) =>
      suggestion(`s${i}`, i === 0 ? 'Because you watch Kaitlyn' : 'From Vixen'),
    );
    const fixture = await render({
      list: vi.fn().mockReturnValue(of({ items, message: null })),
      dismiss,
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Because you watch Kaitlyn');
    // Eight at first, the rest behind Show more.
    expect(root.querySelectorAll('.enjoy-item:not(.extra)').length).toBe(8);
    expect(root.textContent).toContain('Show 2 more');

    (root.querySelector('[data-testid="not-interested"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(dismiss).toHaveBeenCalledWith(items[0]);
    expect(root.textContent).not.toContain('Because you watch Kaitlyn');
  });

  it('says why when there’s nothing, and fails quietly', async () => {
    let fixture = await render({
      list: vi.fn().mockReturnValue(of({ items: [], message: 'Watch a few scenes first.' })),
    });
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Watch a few scenes first.',
    );
    TestBed.resetTestingModule();
    fixture = await render({ list: vi.fn().mockReturnValue(throwError(() => new Error('down'))) });
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Couldn’t pick scenes');
  });
});
