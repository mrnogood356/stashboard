import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboutApiService, ReleaseNotesResponse } from '../../core/api/about.service';
import { SEEN_VERSION_KEY, WhatsNewComponent } from './whats-new.component';
import { WhatsNewService } from './whats-new.service';

const NOTES: ReleaseNotesResponse = {
  current: '1.4.0',
  releases: [
    {
      version: '1.4.0',
      date: '2026-11-01',
      features: ['Back up every setting to a file'],
      fixes: ['Pushover test works'],
    },
  ],
};

describe('WhatsNewComponent', () => {
  beforeEach(() => localStorage.removeItem(SEEN_VERSION_KEY));
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.removeItem(SEEN_VERSION_KEY);
  });

  async function render(response: ReleaseNotesResponse, latest: ReleaseNotesResponse = NOTES) {
    const changes = vi.fn().mockReturnValue(of(response));
    const latestChanges = vi.fn().mockReturnValue(of(latest));
    await TestBed.configureTestingModule({
      imports: [WhatsNewComponent],
      providers: [{ provide: AboutApiService, useValue: { changes, latestChanges } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(WhatsNewComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, changes };
  }

  it('shows what changed since the version this browser last saw, once', async () => {
    localStorage.setItem(SEEN_VERSION_KEY, '1.3.0');
    const { fixture, changes } = await render(NOTES);
    const root = fixture.nativeElement as HTMLElement;

    expect(changes).toHaveBeenCalledWith('1.3.0');
    const dialog = root.querySelector('[data-testid="whats-new"]') as HTMLDialogElement;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.textContent).toContain('What’s new in Stashboard 1.4.0');
    expect(dialog.textContent).toContain('Back up every setting to a file');
    expect(dialog.textContent).toContain('Pushover test works');

    (root.querySelector('[data-testid="whats-new-close"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(dialog.hasAttribute('open')).toBe(false);
    expect(localStorage.getItem(SEEN_VERSION_KEY)).toBe('1.4.0');
  });

  it('shows the notes the server has for a browser that remembers no version', async () => {
    const { fixture, changes } = await render(NOTES);

    expect(changes).toHaveBeenCalledWith(null);
    expect(
      (
        fixture.nativeElement.querySelector('[data-testid="whats-new"]') as HTMLElement
      ).hasAttribute('open'),
    ).toBe(true);
  });

  it('opens the running release’s notes when About asks', async () => {
    localStorage.setItem(SEEN_VERSION_KEY, '1.4.0');
    const { fixture } = await render({ current: '1.4.0', releases: [] });
    const dialog = fixture.nativeElement.querySelector(
      '[data-testid="whats-new"]',
    ) as HTMLDialogElement;
    expect(dialog.hasAttribute('open')).toBe(false);

    TestBed.inject(WhatsNewService).show();
    fixture.detectChanges();

    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.textContent).toContain('Back up every setting to a file');
  });

  it('only remembers the version on a first visit', async () => {
    const { fixture } = await render({ current: '1.4.0', releases: [] });

    expect(
      (
        fixture.nativeElement.querySelector('[data-testid="whats-new"]') as HTMLElement
      ).hasAttribute('open'),
    ).toBe(false);
    expect(localStorage.getItem(SEEN_VERSION_KEY)).toBe('1.4.0');
  });

  it('ignores edge and local builds', async () => {
    localStorage.setItem(SEEN_VERSION_KEY, '1.3.0');
    const { fixture } = await render({ ...NOTES, current: 'edge-abc1234' });

    expect(
      (
        fixture.nativeElement.querySelector('[data-testid="whats-new"]') as HTMLElement
      ).hasAttribute('open'),
    ).toBe(false);
    expect(localStorage.getItem(SEEN_VERSION_KEY)).toBe('1.3.0');
  });
});
