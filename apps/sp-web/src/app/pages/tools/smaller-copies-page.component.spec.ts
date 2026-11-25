import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { SmallerCopies, SmallerCopiesApiService } from '../../core/api/smaller-copies.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { ReleaseSearchService } from '../../core/releases/release-search.service';
import { SmallerCopiesPageComponent } from './smaller-copies-page.component';

const DATA: SmallerCopies = {
  settings: {
    enabled: true,
    target: '1080p',
    replaceHigher: true,
    upgradeLower: false,
    maxGbPerHour: null,
    minGbPerHour: null,
    maxNewGbPerHour: null,
    minNewGbPerHour: null,
    minSavingsPercent: 10,
    codec: 'any',
    prefer: 'largest',
    matchStrength: 'strong',
    studioMode: 'only',
    studioNames: ['Jane Studio'],
    autoGrab: false,
    oldCopy: 'delete',
    scenesPerHour: 10,
    activeFromHour: null,
    activeToHour: null,
  },
  blocked: null,
  candidates: 12,
  due: 9,
  lastSearchAt: null,
  saved: { bytes: 0, scenes: 0 },
  recent: [
    {
      stashSceneId: '2',
      title: 'Beach Day',
      outcome: 'found',
      detail: 'A match that fits the rules.',
      releaseTitle: 'Jane.Beach.Day.1080p.x265',
      canGrab: true,
      oldSize: 8 * 1024 ** 3,
      newSize: 2 * 1024 ** 3,
      searchedAt: '2026-11-05T12:00:00.000Z',
    },
    {
      stashSceneId: '3',
      title: 'Park',
      outcome: 'none-found',
      detail: null,
      releaseTitle: null,
      canGrab: false,
      oldSize: null,
      newSize: null,
      searchedAt: '2026-11-05T11:00:00.000Z',
    },
  ],
  tries: [
    {
      id: 't1',
      stashSceneId: '4',
      title: 'Lake',
      releaseTitle: 'Jane.Lake.1080p.broken',
      outcome: 'failed',
      detail: 'The download failed: missing articles This release won’t be grabbed again.',
      oldSize: 6 * 1024 ** 3,
      newSize: 1.5 * 1024 ** 3,
      at: '2026-11-05T10:00:00.000Z',
    },
    {
      id: 't2',
      stashSceneId: '5',
      title: 'Garden',
      releaseTitle: 'Jane.Garden.1080p',
      outcome: 'replaced',
      detail: 'Deleted the old file.',
      oldSize: 5 * 1024 ** 3,
      newSize: 1 * 1024 ** 3,
      at: '2026-11-05T09:00:00.000Z',
    },
  ],
  tryCounts: { failed: 1, replaced: 1 },
};

async function render(
  data: SmallerCopies = DATA,
  searched: SmallerCopies = data,
  failFirst = false,
) {
  const api = {
    status: vi.fn(() => of(data)),
    save: vi.fn(() => of(data)),
    searchNow: vi.fn(() => of(searched)),
    grab: vi.fn(() => of(data)),
    recheck: vi.fn(() => of(data)),
    recheckAll: vi.fn(() => of(data)),
    recheckFailed: vi.fn(() => of(data)),
    removeNewCopy: vi.fn(() => of(data)),
  };
  const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [SmallerCopiesPageComponent],
    providers: [
      provideRouter([]),
      { provide: SmallerCopiesApiService, useValue: api },
      { provide: AppNotificationsService, useValue: notifications },
    ],
  }).compileComponents();
  if (failFirst) {
    api.status.mockReturnValueOnce(throwError(() => new Error('down')));
  }
  const fixture = TestBed.createComponent(SmallerCopiesPageComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const openTab = (id: 'overview' | 'matches' | 'tried' | 'rules') => {
    (root.querySelector(`[data-testid="better-tab-${id}"]`) as HTMLButtonElement).click();
    fixture.detectChanges();
  };
  const component = (f: typeof fixture) => f.componentInstance;
  return { fixture, root, api, notifications, openTab, component };
}

describe('SmallerCopiesPageComponent', () => {
  it('says why Search now found nothing to search, instead of doing nothing', async () => {
    const { root, fixture, notifications } = await render(DATA, {
      ...DATA,
      notice:
        '2 replacements are still on their way in; it searches again once they’re in your library.',
    });
    (root.querySelector('[data-testid="better-search-now"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(notifications.info).toHaveBeenCalledWith(
      'Nothing searched',
      expect.stringContaining('2 replacements are still on their way in'),
    );
  });

  it('shows how many scenes fit the rules, and a match waiting under Matches with a Grab button', async () => {
    const { root, api, openTab } = await render();
    const status = root.querySelector('[data-testid="smaller-status"]')!;
    expect(status.textContent).toContain('12 scenes fit the rules, 9 to look at');
    expect(status.textContent).toContain('1 waiting for you');
    // The overview lists what it did; the match waits on its own tab.
    expect(root.querySelector('[data-testid="attempt-2"]')).toBeNull();
    expect(root.querySelector('[data-testid="better-tab-matches"]')!.textContent).toContain('1');
    openTab('matches');
    const found = root.querySelector('[data-testid="attempt-2"]')!;
    expect(found.textContent).toContain('Match waiting');
    expect(found.textContent).toContain('8.0 GB');
    expect(found.textContent).toContain('2.0 GB');
    (found.querySelector('button') as HTMLButtonElement).click();
    expect(api.grab).toHaveBeenCalledWith('2');
    openTab('overview');
    expect(root.querySelector('[data-testid="attempt-3"]')!.textContent).toContain('Nothing yet');
    // Nothing to grab there, but it can be looked at again.
    expect(root.querySelector('[data-testid="attempt-3"] button.primary')).toBeNull();
    (root.querySelector('[data-testid="recheck-3"]') as HTMLButtonElement).click();
    expect(api.recheck).toHaveBeenCalledWith('3');
  });

  it('checks every scene again only after a second tap', async () => {
    const { root, fixture, api } = await render();
    const button = root.querySelector('[data-testid="better-recheck-all"]') as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    expect(api.recheckAll).not.toHaveBeenCalled();
    expect(button.textContent).toContain('Tap again');
    expect(root.querySelector('[data-testid="better-recheck-all-note"]')!.textContent).toContain(
      'aren’t grabbed again',
    );
    button.click();
    expect(api.recheckAll).toHaveBeenCalledTimes(1);
  });

  it('lists every release tried, failed ones too, and narrows to one outcome', async () => {
    const { root, fixture, api, openTab } = await render();
    expect(root.querySelector('[data-testid="better-tab-tried"]')!.textContent).toContain(
      '1 failed',
    );
    openTab('tried');
    expect(root.querySelector('[data-testid="try-t1"]')!.textContent).toContain('Failed');
    expect(root.querySelector('[data-testid="try-t2"]')!.textContent).toContain('Replaced');
    expect(root.querySelector('[data-testid="tried-filter-all"]')!.textContent).toContain('2');
    (root.querySelector('[data-testid="tried-filter-failed"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="try-t2"]')).toBeNull();
    // A failed one can look for another now, rather than waiting its turn.
    (root.querySelector('[data-testid="try-again-t1"]') as HTMLButtonElement).click();
    expect(api.recheck).toHaveBeenCalledWith('4', true);
  });

  it('offers no "Look for another" on a failure a later try for the scene moved past', async () => {
    const { root, openTab } = await render({
      ...DATA,
      tries: [
        {
          id: 't9',
          stashSceneId: '4',
          title: 'Lake',
          releaseTitle: 'Jane.Lake.1080p.good',
          outcome: 'kept-both',
          detail: 'Both were kept to check by hand.',
          oldSize: null,
          newSize: null,
          at: '2026-11-06T10:00:00.000Z',
        },
        ...DATA.tries,
      ],
      tryCounts: { failed: 1, replaced: 1, 'kept-both': 1 },
    });
    openTab('tried');
    // The old failure for scene 4 is still listed, without the button.
    expect(root.querySelector('[data-testid="try-t1"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="try-again-t1"]')).toBeNull();
  });

  it('offers no "Look for another" on a scene where both copies were kept', async () => {
    const { root, openTab } = await render({
      ...DATA,
      tries: [
        {
          id: 't3',
          stashSceneId: '6',
          title: 'Hill',
          releaseTitle: 'Jane.Hill.1080p',
          outcome: 'kept-both',
          detail: 'Both files are on the scene now, as the rules ask.',
          oldSize: null,
          newSize: null,
          at: '2026-11-05T08:00:00.000Z',
        },
      ],
      tryCounts: { 'kept-both': 1 },
    });
    openTab('tried');
    expect(root.querySelector('[data-testid="try-again-t3"]')).toBeNull();
    // Choosing a release yourself is still offered.
    expect(root.querySelector('[data-testid="choose-try-t3"]')).not.toBeNull();
  });

  it('opens "Choose a release" for the scene, and shows the grab once it’s sent', async () => {
    const { root, openTab, fixture, api } = await render({
      ...DATA,
      tries: [
        {
          id: 't3',
          stashSceneId: '6',
          title: 'Hill',
          releaseTitle: 'Jane.Hill.1080p',
          outcome: 'kept-both',
          detail: null,
          oldSize: null,
          newSize: null,
          at: '2026-11-05T08:00:00.000Z',
        },
      ],
      tryCounts: { 'kept-both': 1 },
    });
    const search = TestBed.inject(ReleaseSearchService);
    openTab('tried');
    (root.querySelector('[data-testid="choose-try-t3"]') as HTMLButtonElement).click();
    expect(search.target()).toEqual({ stashId: '6', title: 'Hill', source: 'replacement' });

    api.status.mockClear();
    search.done();
    fixture.detectChanges();
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it('links to the scene a kept-both download landed on, and removes it on a second tap', async () => {
    const kept = {
      id: 't4',
      stashSceneId: '6',
      title: 'Hill',
      releaseTitle: 'Other.Clip.1080p',
      outcome: 'kept-both',
      detail: 'The new file runs 14 min and the old one 20 min.',
      oldSize: null,
      newSize: null,
      at: '2026-11-05T08:00:00.000Z',
      newSceneId: '50',
      canRemoveNew: true,
    };
    const { root, api, fixture, openTab } = await render({
      ...DATA,
      tries: [kept, { ...kept, id: 't5', newSceneId: null }],
      tryCounts: { 'kept-both': 2 },
    });
    openTab('tried');
    const link = root.querySelector('[data-testid="see-new-t4"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/library/scene/50');
    // Joined to the old scene: nothing separate to show or remove.
    expect(root.querySelector('[data-testid="see-new-t5"]')).toBeNull();
    expect(root.querySelector('[data-testid="remove-new-t5"]')).toBeNull();

    const remove = () => root.querySelector('[data-testid="remove-new-t4"]') as HTMLButtonElement;
    remove().click();
    fixture.detectChanges();
    expect(api.removeNewCopy).not.toHaveBeenCalled();
    expect(remove().textContent).toContain('Delete it from disk?');
    remove().click();
    expect(api.removeNewCopy).toHaveBeenCalledWith('t4');
  });

  it('takes back a first "Remove it" tap on leaving the filter or the button', async () => {
    const kept = {
      id: 't4',
      stashSceneId: '6',
      title: 'Hill',
      releaseTitle: 'Other.Clip.1080p',
      outcome: 'kept-both',
      detail: null,
      oldSize: null,
      newSize: null,
      at: '2026-11-05T08:00:00.000Z',
      newSceneId: '50',
      canRemoveNew: true,
    };
    const { root, api, fixture, openTab } = await render({
      ...DATA,
      tries: [kept],
      tryCounts: { 'kept-both': 1 },
    });
    openTab('tried');
    const remove = () => root.querySelector('[data-testid="remove-new-t4"]') as HTMLButtonElement;
    remove().click();
    fixture.detectChanges();
    (root.querySelector('[data-testid="tried-filter-kept-both"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    (root.querySelector('[data-testid="tried-filter-all"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(remove().textContent).toContain('Remove it');
    remove().click();
    fixture.detectChanges();
    remove().dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(remove().textContent).toContain('Remove it');
    remove().click();
    expect(api.removeNewCopy).not.toHaveBeenCalled();
  });

  it('links to a new scene holding other files but offers no removal', async () => {
    const { root, openTab } = await render({
      ...DATA,
      tries: [
        {
          id: 't6',
          stashSceneId: '6',
          title: 'Hill',
          releaseTitle: 'Other.Clip.1080p',
          outcome: 'kept-both',
          detail: null,
          oldSize: null,
          newSize: null,
          at: '2026-11-05T08:00:00.000Z',
          newSceneId: '51',
          canRemoveNew: false,
        },
      ],
      tryCounts: { 'kept-both': 1 },
    });
    openTab('tried');
    expect(root.querySelector('[data-testid="see-new-t6"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="remove-new-t6"]')).toBeNull();
  });

  it('checks only the failed scenes again, in one tap, when some are waiting', async () => {
    const { root, api } = await render({ ...DATA, failed: 3 });
    const button = root.querySelector('[data-testid="better-recheck-failed"]') as HTMLButtonElement;
    expect(button.textContent).toContain('Check only the 3 failed');
    button.click();
    expect(api.recheckFailed).toHaveBeenCalledTimes(1);
    expect(api.recheckAll).not.toHaveBeenCalled();
  });

  it('hides "check failed again" when no failed scene is waiting', async () => {
    const { root } = await render();
    expect(root.querySelector('[data-testid="better-recheck-failed"]')).toBeNull();
  });

  it('shows the space given back in whole GB until it’s past 10 TB, so each swap shows', async () => {
    const { root } = await render({
      ...DATA,
      saved: { bytes: 1.37 * 1024 ** 4, scenes: 399 },
    });
    expect(root.querySelector('[data-testid="smaller-saved"]')!.textContent).toContain(
      'Given back 1,403 GB so far, across 399 scenes replaced.',
    );
  });

  it('drops a refresh read before a save, so the old rules don’t come back', async () => {
    const { component, api, fixture } = await render();
    const page = component(fixture) as unknown as { refresh(): void };
    const stale = new Subject<SmallerCopies>();
    api.status.mockReturnValueOnce(stale);
    page.refresh();
    const saved = { ...DATA, settings: { ...DATA.settings, scenesPerHour: 30 } };
    api.save.mockReturnValueOnce(of(saved));
    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="better-enabled"]',
    ) as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    // The old answer lands after the save: ignored.
    stale.next(DATA);
    stale.complete();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(api.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, scenesPerHour: 30 }),
    );
  });

  it('drops a refresh read while a save is on its way', async () => {
    const { component, api, fixture } = await render();
    const page = component(fixture) as unknown as { refresh(): void };
    const saving = new Subject<SmallerCopies>();
    api.save.mockReturnValueOnce(saving);
    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="better-enabled"]',
    ) as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    // A refresh starts while the save is still on its way…
    const stale = new Subject<SmallerCopies>();
    api.status.mockReturnValueOnce(stale);
    page.refresh();
    // …the save lands, then the refresh with the old rules.
    saving.next({ ...DATA, settings: { ...DATA.settings, scenesPerHour: 30 } });
    saving.complete();
    stale.next(DATA);
    stale.complete();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(api.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, scenesPerHour: 30 }),
    );
  });

  it('drops a Check again answer when a save landed while it was on its way', async () => {
    const { api, fixture, openTab } = await render();
    const rechecking = new Subject<SmallerCopies>();
    api.recheck.mockReturnValueOnce(rechecking);
    openTab('overview');
    (fixture.nativeElement.querySelector('[data-testid="recheck-3"]') as HTMLButtonElement).click();
    api.save.mockReturnValueOnce(
      of({ ...DATA, settings: { ...DATA.settings, scenesPerHour: 30 } }),
    );
    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="better-enabled"]',
    ) as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    // The recheck answers last, with the rules from before the save.
    rechecking.next(DATA);
    rechecking.complete();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(api.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, scenesPerHour: 30 }),
    );
  });

  it('fills the rules form from a later refresh when the first load failed', async () => {
    const { fixture, api, root, openTab } = await render(DATA, DATA, true);
    expect(root.querySelector('[data-testid="better-tab-rules"]')).toBeNull();
    api.status.mockReturnValue(of(DATA));
    (fixture.componentInstance as unknown as { refresh(): void }).refresh();
    fixture.detectChanges();
    openTab('rules');
    expect(root.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it('turns on and off from the overview straight away', async () => {
    const { root, api } = await render();
    const toggle = root.querySelector('[data-testid="better-enabled"]') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('offers presets, and says when the rules are fine-tuned past them', async () => {
    const { fixture, root, api, openTab } = await render();
    openTab('rules');
    // These rules are none of the presets.
    expect(root.textContent).toContain('Fine-tuned');
    (root.querySelector('[data-testid="preset-save-space"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(
      root.querySelector('[data-testid="preset-save-space"]')!.getAttribute('aria-pressed'),
    ).toBe('true');
    (root.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    expect(api.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replaceHigher: true,
        upgradeLower: false,
        maxGbPerHour: 6,
        minNewGbPerHour: 1.5,
        minSavingsPercent: 25,
      }),
    );
  });

  it('shows the space given back once something was replaced', async () => {
    const before = await render();
    expect(before.root.querySelector('[data-testid="smaller-saved"]')).toBeNull();
    TestBed.resetTestingModule();

    const { root } = await render({ ...DATA, saved: { bytes: 12.5 * 1024 ** 3, scenes: 3 } });
    expect(root.querySelector('[data-testid="smaller-saved"]')!.textContent).toContain(
      'Given back 12.5 GB so far, across 3 scenes replaced.',
    );
  });

  it('saves every rule, with the studios one per line', async () => {
    const { fixture, root, api, openTab } = await render();
    openTab('rules');
    await fixture.whenStable();
    fixture.detectChanges();
    const textarea = root.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Jane Studio\nOther Studio\n\n';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (root.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    expect(api.save).toHaveBeenCalledWith({
      ...DATA.settings,
      studioNames: ['Jane Studio', 'Other Studio'],
    });
  });

  it('says why it isn’t running, with no Search button to press', async () => {
    const { root } = await render({ ...DATA, blocked: 'Off.' });
    const status = root.querySelector('[data-testid="smaller-status"]')!;
    expect(status.textContent).toContain('Off.');
    expect(
      (status.querySelector('[data-testid="better-search-now"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('keeps each Grab off until its own answer, so nothing is sent twice', async () => {
    const two = {
      ...DATA,
      recent: [DATA.recent[0], { ...DATA.recent[0], stashSceneId: '5', title: 'Other' }],
    };
    const { fixture, root, api, openTab } = await render(two);
    openTab('matches');
    const pending = new Subject<SmallerCopies>();
    api.grab.mockReturnValueOnce(pending).mockReturnValueOnce(new Subject<SmallerCopies>());
    const buttonFor = (id: string) =>
      root.querySelector(`[data-testid="attempt-${id}"] button`) as HTMLButtonElement;
    buttonFor('2').click();
    fixture.detectChanges();
    buttonFor('5').click();
    fixture.detectChanges();
    expect(buttonFor('2').disabled).toBe(true);
    buttonFor('2').click();
    expect(api.grab).toHaveBeenCalledTimes(2);
    pending.next(two);
    fixture.detectChanges();
    expect(buttonFor('2').disabled).toBe(false);
  });
});
