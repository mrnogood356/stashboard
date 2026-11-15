import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { SmallerCopies, SmallerCopiesApiService } from '../../core/api/smaller-copies.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
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
};

async function render(data: SmallerCopies = DATA, searched: SmallerCopies = data) {
  const api = {
    status: vi.fn(() => of(data)),
    save: vi.fn(() => of(data)),
    searchNow: vi.fn(() => of(searched)),
    grab: vi.fn(() => of(data)),
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
  const fixture = TestBed.createComponent(SmallerCopiesPageComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const openTab = (id: 'overview' | 'matches' | 'rules') => {
    (root.querySelector(`[data-testid="better-tab-${id}"]`) as HTMLButtonElement).click();
    fixture.detectChanges();
  };
  return { fixture, root, api, notifications, openTab };
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
    expect(root.querySelector('[data-testid="attempt-3"] button')).toBeNull();
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
