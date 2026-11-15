import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { Suggestion, SuggestionsApiService } from '../../core/api/suggestions.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { YouMayEnjoyComponent } from './you-may-enjoy.component';
import { YouMayEnjoyState } from './you-may-enjoy.state';

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
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.removeItem('stashboard.enjoy.tags');
  });

  async function render(api: Partial<SuggestionsApiService>, full = false) {
    await TestBed.configureTestingModule({
      imports: [YouMayEnjoyComponent],
      providers: [
        provideRouter([]),
        { provide: SuggestionsApiService, useValue: api },
        { provide: AppNotificationsService, useValue: { error: vi.fn(), success: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(YouMayEnjoyComponent);
    fixture.componentRef.setInput('full', full);
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

  it('brings the next pick in when one is hidden, never the hidden one', async () => {
    const shown = [suggestion('a', 'x'), suggestion('b', 'x')];
    const list = vi
      .fn()
      .mockReturnValueOnce(of({ items: shown, message: null }))
      // The server's next look: the hidden one gone, the next in line after.
      .mockReturnValueOnce(of({ items: [shown[1], suggestion('c', 'x')], message: null }));
    const fixture = await render({ list, dismiss: vi.fn().mockReturnValue(of(undefined)) });
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('[data-testid="not-interested"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const titles = Array.from(root.querySelectorAll('.enjoy-item')).map(
      (item) => item.querySelector('app-scene-card')?.textContent ?? '',
    );
    expect(titles).toHaveLength(2);
    expect(titles[0]).toContain('Scene b');
    expect(titles[1]).toContain('Scene c');
  });

  it('shuffles to a fresh set, on the section and on its page', async () => {
    const first = [suggestion('a', 'x'), suggestion('b', 'x')];
    const fresh = [suggestion('c', 'x'), suggestion('d', 'x')];
    const shuffle = vi.fn().mockReturnValue(of({ items: fresh, message: null }));
    const fixture = await render(
      { list: vi.fn().mockReturnValue(of({ items: first, message: null })), shuffle },
      true,
    );
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('2 picks');

    (root.querySelector('[data-testid="enjoy-shuffle"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(shuffle).toHaveBeenCalledWith(60, []);
    const text = root.textContent ?? '';
    expect(text).toContain('Scene c');
    expect(text).not.toContain('Scene a');
  });

  it('links the section to its own page, which lists every pick', async () => {
    const items = Array.from({ length: 10 }, (_, i) => suggestion(`s${i}`, 'From Vixen'));
    const section = await render({ list: vi.fn().mockReturnValue(of({ items, message: null })) });
    expect(
      section.nativeElement.querySelector('[data-testid="enjoy-see-all"]')?.getAttribute('href'),
    ).toBe('/you-may-enjoy');
    TestBed.resetTestingModule();

    const list = vi.fn().mockReturnValue(of({ items, message: null }));
    const page = await render({ list }, true);
    const root = page.nativeElement as HTMLElement;
    expect(list).toHaveBeenCalledWith(60, []);
    expect(root.querySelectorAll('.enjoy-item:not(.extra)').length).toBe(10);
    expect(root.querySelector('[data-testid="show-more"]')).toBeNull();
    expect(root.querySelector('[data-testid="enjoy-see-all"]')).toBeNull();
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

  it('asks only for the categories picked, and remembers them', async () => {
    const list = vi.fn().mockReturnValue(of({ items: [suggestion('a', 'x')], message: null }));
    const fixture = await render({ list }, true);
    const state = TestBed.inject(YouMayEnjoyState);
    expect(list).toHaveBeenLastCalledWith(60, []);

    state.setTags([{ id: 't1', name: 'Outdoor' }]);
    (fixture.componentInstance as unknown as { onTagsPicked(ids: string[]): void }).onTagsPicked([
      't1',
    ]);
    fixture.detectChanges();
    expect(list).toHaveBeenLastCalledWith(60, ['t1']);
    expect(fixture.nativeElement.textContent).toContain('Outdoor');
    expect(JSON.parse(localStorage.getItem('stashboard.enjoy.tags') ?? '[]')).toEqual([
      { id: 't1', name: 'Outdoor' },
    ]);
  });

  it('drops a late answer for categories no longer picked', async () => {
    const forT1 = new Subject<{ items: Suggestion[]; message: null }>();
    const forT2 = new Subject<{ items: Suggestion[]; message: null }>();
    const list = vi.fn((_limit: number, tags: string[]) =>
      tags[0] === 't1'
        ? forT1
        : tags[0] === 't2'
          ? forT2
          : of({ items: [suggestion('start', 'x')], message: null }),
    );
    const fixture = await render({ list } as never, true);
    const state = TestBed.inject(YouMayEnjoyState);
    const pick = (
      fixture.componentInstance as unknown as { onTagsPicked(ids: string[]): void }
    ).onTagsPicked.bind(fixture.componentInstance);

    state.setTags([{ id: 't1', name: 'Outdoor' }]);
    pick(['t1']);
    state.setTags([{ id: 't2', name: 'POV' }]);
    pick(['t2']);
    // POV answers first, then Outdoor's answer arrives late.
    forT2.next({ items: [suggestion('pov', 'x')], message: null });
    forT1.next({ items: [suggestion('outdoor', 'x')], message: null });
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Scene pov');
    expect(text).not.toContain('Scene outdoor');
  });

  it('back from a scene: the same picks, without asking again', async () => {
    const list = vi.fn().mockReturnValue(of({ items: [suggestion('a', 'x')], message: null }));
    const first = await render({ list }, true);
    const link = first.nativeElement.querySelector('app-scene-card a[href*="/scene/"]');
    expect(link?.getAttribute('href')).toContain('returnTo=');
    const state = TestBed.inject(YouMayEnjoyState);
    first.destroy();

    const again = TestBed.createComponent(YouMayEnjoyComponent);
    again.componentRef.setInput('full', true);
    again.detectChanges();
    expect(list).toHaveBeenCalledTimes(1);
    expect(again.nativeElement.textContent).toContain('Scene a');
    expect(state.restore('page')?.items).toHaveLength(1);
  });
});
