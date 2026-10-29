import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscoverService } from '../../core/api/discover.service';
import { HiddenContentService } from '../../core/api/hidden-content.service';
import { SettingsHiddenPageComponent } from './settings-hidden-page.component';

describe('SettingsHiddenPageComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  const saved = {
    words: ['trans', 'transgender'],
    tags: [{ id: 'tag-1', name: 'Trans Woman' }],
    studios: [],
    performers: [{ id: 'p-1', name: 'Jane Doe' }],
  };

  async function render(
    hidden: Partial<Record<keyof HiddenContentService, unknown>>,
    discover: Partial<Record<keyof DiscoverService, unknown>> = {},
  ) {
    await TestBed.configureTestingModule({
      imports: [SettingsHiddenPageComponent],
      providers: [
        { provide: HiddenContentService, useValue: { settings: () => null, ...hidden } },
        {
          provide: DiscoverService,
          useValue: {
            searchSceneTags: vi.fn().mockReturnValue(of([])),
            searchPerformerStudios: vi.fn().mockReturnValue(of([])),
            getPerformersFeed: vi.fn().mockReturnValue(of({ items: [] })),
            ...discover,
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsHiddenPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('shows the saved words, tags and studios', async () => {
    const { root } = await render({ getSettings: vi.fn().mockReturnValue(of(saved)) });

    expect((root.querySelector('input[name="words"]') as HTMLInputElement).value).toBe(
      'trans, transgender',
    );
    expect(root.querySelector('[data-testid="hidden-tags"]')?.textContent).toContain('Trans Woman');
    expect(root.textContent).toContain('Your library is never filtered');
  });

  it('turns "Scenes you already have" on and saves it with the rest', async () => {
    const saveSettings = vi.fn((settings) => of(settings));
    const { fixture, root } = await render({
      getSettings: vi.fn().mockReturnValue(of(saved)),
      saveSettings,
    });
    const toggle = root.querySelector('[data-testid="hide-owned"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    toggle.click();
    fixture.detectChanges();
    (root.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ hideOwned: true }));
  });

  it('follows the saved "Scenes you already have" until the switch is touched', async () => {
    const shared = signal<Record<string, unknown> | null>(null);
    const { fixture, root } = await render({
      settings: shared,
      getSettings: vi.fn().mockReturnValue(of(saved)),
    });
    const toggle = () => root.querySelector('[data-testid="hide-owned"]') as HTMLInputElement;

    // Turned on elsewhere (another tab, or carried over from this device).
    shared.set({ ...saved, hideOwned: true });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(toggle().checked).toBe(true);

    toggle().click();
    fixture.detectChanges();
    shared.set({ ...saved, hideOwned: true });
    fixture.detectChanges();
    expect(toggle().checked).toBe(false);
  });

  it('finds a tag in the catalog, adds it and saves everything', async () => {
    const saveSettings = vi.fn((settings) => of(settings));
    const searchSceneTags = vi.fn().mockReturnValue(
      of([
        { id: 'tag-1', name: 'Trans Woman', description: null, aliases: [] },
        { id: 'tag-2', name: 'Transgender', description: null, aliases: [] },
      ]),
    );
    const { fixture, root } = await render(
      { getSettings: vi.fn().mockReturnValue(of(saved)), saveSettings },
      { searchSceneTags },
    );
    vi.useFakeTimers();

    const search = root.querySelector('[data-testid="hidden-tags"] input') as HTMLInputElement;
    search.value = 'trans';
    search.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(400);
    fixture.detectChanges();

    expect(searchSceneTags).toHaveBeenCalledWith('trans');
    const suggestions = Array.from(
      root.querySelectorAll('[data-testid="hidden-tags"] .suggestion'),
    ) as HTMLButtonElement[];
    // Already hidden tags aren't suggested again.
    expect(suggestions.map((button) => button.textContent?.trim())).toEqual(['Transgender']);
    suggestions[0].click();
    fixture.detectChanges();

    const words = root.querySelector('input[name="words"]') as HTMLInputElement;
    words.value = 'trans, transgender, pov';
    words.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(saveSettings).toHaveBeenCalledWith({
      words: ['trans', 'transgender', 'pov'],
      tags: [
        { id: 'tag-1', name: 'Trans Woman' },
        { id: 'tag-2', name: 'Transgender' },
      ],
      studios: [],
      performers: [{ id: 'p-1', name: 'Jane Doe' }],
      hideOwned: false,
    });
    expect(root.textContent).toContain('Saved.');
  });

  it('offers a studio’s sub-studios too, and removes a chosen one', async () => {
    const searchPerformerStudios = vi
      .fn()
      .mockReturnValue(
        of([{ id: 's-1', name: 'Parent', childStudios: [{ id: 's-2', name: 'Child' }] }]),
      );
    const { fixture, root } = await render(
      { getSettings: vi.fn().mockReturnValue(of({ ...saved, tags: [] })) },
      { searchPerformerStudios },
    );
    vi.useFakeTimers();

    const search = root.querySelector('[data-testid="hidden-studios"] input') as HTMLInputElement;
    search.value = 'par';
    search.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(400);
    fixture.detectChanges();

    const studios = root.querySelector('[data-testid="hidden-studios"]') as HTMLElement;
    const suggestions = Array.from(studios.querySelectorAll('.suggestion')) as HTMLButtonElement[];
    expect(suggestions.map((button) => button.textContent?.trim())).toEqual(['Parent', 'Child']);
    suggestions[1].click();
    fixture.detectChanges();
    expect(studios.querySelector('.chips')?.textContent).toContain('Child');

    (studios.querySelector('.chip-remove') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(studios.querySelector('.chips')).toBeNull();
  });

  it('says why saving failed', async () => {
    const { fixture, root } = await render({
      getSettings: vi.fn().mockReturnValue(of(saved)),
      saveSettings: vi.fn().mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 400,
              error: { message: 'words must contain no more than 100 elements' },
            }),
        ),
      ),
    });

    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(root.textContent).toContain('words must contain no more than 100 elements');
  });

  it('says when the list could not be loaded, and offers no form that would wipe it', async () => {
    const getSettings = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('down')))
      .mockReturnValue(of(saved));
    const { fixture, root } = await render({ getSettings, saveSettings: vi.fn() });

    expect(root.textContent).toContain('couldn’t be loaded');
    expect(root.querySelector('form')).toBeNull();

    (root.querySelector('.load-failed button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(root.querySelector('form')).not.toBeNull();
  });

  it('lists a validation error the server sends as a list', async () => {
    const { fixture, root } = await render({
      getSettings: vi.fn().mockReturnValue(of(saved)),
      saveSettings: vi.fn().mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 400,
              error: { message: ['tags.0.id must be a string', 'studios must be an array'] },
            }),
        ),
      ),
    });

    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(root.textContent).toContain('tags.0.id must be a string. studios must be an array');
  });

  it('finds a performer in the catalog and hides them', async () => {
    const saveSettings = vi.fn((settings) => of(settings));
    const getPerformersFeed = vi
      .fn()
      .mockReturnValue(of({ items: [{ id: 'p-2', name: 'John Roe' }] }));
    const { fixture, root } = await render(
      { getSettings: vi.fn().mockReturnValue(of(saved)), saveSettings },
      { getPerformersFeed },
    );
    vi.useFakeTimers();

    const performers = root.querySelector('[data-testid="hidden-performers"]') as HTMLElement;
    expect(performers.textContent).toContain('Jane Doe');
    const search = performers.querySelector('input') as HTMLInputElement;
    search.value = 'john';
    search.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(400);
    fixture.detectChanges();

    expect(getPerformersFeed).toHaveBeenCalledWith(1, 8, { name: 'john' });
    (performers.querySelector('.suggestion') as HTMLButtonElement).click();
    fixture.detectChanges();
    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        performers: [
          { id: 'p-1', name: 'Jane Doe' },
          { id: 'p-2', name: 'John Roe' },
        ],
      }),
    );
  });
});
