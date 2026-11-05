import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
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
    maxFileSizeGb: null,
    minFileSizeGb: null,
    maxNewSizeGb: null,
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

async function render(data: SmallerCopies = DATA) {
  const api = {
    status: vi.fn(() => of(data)),
    save: vi.fn(() => of(data)),
    searchNow: vi.fn(() => of(data)),
    grab: vi.fn(() => of(data)),
  };
  const notifications = { success: vi.fn(), error: vi.fn() };
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
  return { fixture, root: fixture.nativeElement as HTMLElement, api, notifications };
}

describe('SmallerCopiesPageComponent', () => {
  it('shows how many scenes fit the rules, and a match waiting with a Grab button', async () => {
    const { root, api } = await render();
    expect(root.querySelector('[data-testid="smaller-status"]')!.textContent).toContain(
      '12 scenes fit the rules, 9 to look at',
    );
    const found = root.querySelector('[data-testid="attempt-2"]')!;
    expect(found.textContent).toContain('Match waiting');
    expect(found.textContent).toContain('8.0 GB');
    expect(found.textContent).toContain('2.0 GB');
    (found.querySelector('button') as HTMLButtonElement).click();
    expect(api.grab).toHaveBeenCalledWith('2');
    expect(root.querySelector('[data-testid="attempt-3"] button')).toBeNull();
  });

  it('saves every rule, with the studios one per line', async () => {
    const { fixture, root, api } = await render();
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
    expect((status.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
