import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DownloadHandoffApiService,
  DownloadHandoffSettings,
} from '../../core/api/download-handoff.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { OrganizerApiService } from '../../core/api/organizer.service';
import { FinishedDownloadsComponent } from './finished-downloads.component';

function settings(overrides: Partial<DownloadHandoffSettings> = {}): DownloadHandoffSettings {
  return {
    enabled: false,
    category: 'stashboard',
    destination: '/data/downloads',
    sabPathFrom: '/downloads',
    sabPathTo: '/mnt/downloads',
    importMode: 'move',
    dropIns: false,
    sabManualJobs: true,
    sabManualSince: '2026-10-21T10:00:00.000Z',
    dropInFolder: '/mnt/downloads/complete/stashboard-downloads',
    sabnzbdReady: true,
    libraryRoots: ['/data'],
    ...overrides,
  };
}

function text(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('FinishedDownloadsComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(
    options: {
      loaded?: DownloadHandoffSettings;
      ready?: boolean;
      filingExample?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const organizer = { filingExample: options.filingExample ?? vi.fn().mockReturnValue(of(null)) };
    const api = {
      settings: vi.fn().mockReturnValue(of(options.loaded ?? settings())),
      update: vi.fn(),
    };
    const notifications = { success: vi.fn(), error: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [FinishedDownloadsComponent],
      providers: [
        provideRouter([]),
        { provide: DownloadHandoffApiService, useValue: api },
        { provide: AppNotificationsService, useValue: notifications },
        { provide: OrganizerApiService, useValue: organizer },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(FinishedDownloadsComponent);
    fixture.componentInstance.sabnzbdReady = options.ready ?? true;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const input = (name: string) =>
      root.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement;
    return { fixture, root, api, notifications, input, organizer };
  }

  it('fills the form from the saved settings and lists Stash’s library folders', async () => {
    const { root, input } = await render();

    expect((input('enabled') as HTMLInputElement).checked).toBe(false);
    expect(input('category').value).toBe('stashboard');
    expect(input('destination').value).toBe('/data/downloads');
    expect(input('sabPathFrom').value).toBe('/downloads');
    expect(input('sabPathTo').value).toBe('/mnt/downloads');
    expect(input('importMode').value).toBe('move');
    expect(text(root)).toContain('A folder inside one of Stash’s library folders (/data)');
    expect(text(root)).not.toContain('Save & Test SABnzbd above first.');
  });

  it('shows where a finished download would be filed, for the folder typed in', async () => {
    const filingExample = vi.fn((destination: string) =>
      of(
        destination === '/elsewhere'
          ? {
              title: 'Summer Afternoon',
              landsAt: '/elsewhere/summer.mp4',
              filedAt: null,
              state: 'outside',
              pattern: '{studio}/{title}',
            }
          : {
              title: 'Summer Afternoon',
              landsAt: '/data/downloads/summer.mp4',
              filedAt: '/data/Bright Studio/Summer Afternoon.mp4',
              state: 'ready',
              pattern: '{studio}/{title}',
            },
      ),
    );
    const wait = () => new Promise((resolve) => setTimeout(resolve, 450));
    const { fixture, root, input } = await render({ filingExample });
    await wait();
    fixture.detectChanges();
    const example = () => text(root.querySelector('[data-testid="filing-example"]'));
    expect(filingExample).toHaveBeenCalledWith('/data/downloads');
    expect(example()).toContain(
      '“Summer Afternoon” lands as /data/downloads/summer.mp4 and is filed at /data/Bright Studio/Summer Afternoon.mp4.',
    );

    const destination = input('destination') as HTMLInputElement;
    destination.value = '/elsewhere';
    destination.dispatchEvent(new Event('input'));
    // The old folder's example goes at once, not when the new one comes.
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="filing-example"]')).toBeNull();
    await wait();
    fixture.detectChanges();
    expect(example()).toContain(
      'isn’t filed: that folder isn’t inside one of Stash’s library folders',
    );

    // Cleared: no example.
    destination.value = '';
    destination.dispatchEvent(new Event('input'));
    await wait();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="filing-example"]')).toBeNull();
    expect(filingExample).toHaveBeenCalledTimes(2);
  });

  it('shows the saved folder’s example after saving', async () => {
    const filingExample = vi.fn((destination: string) =>
      of({
        title: 'T',
        landsAt: `${destination}/t.mp4`,
        filedAt: `${destination}/S/T/T.mp4`,
        state: 'ready' as const,
        pattern: '{studio}/{title}',
      }),
    );
    const wait = () => new Promise((resolve) => setTimeout(resolve, 450));
    const { fixture, root, api, input } = await render({ filingExample });
    // The server keeps a tidied folder: its example is the one shown.
    api.update.mockReturnValue(of(settings({ destination: '/data/saved' })));
    const destination = input('destination') as HTMLInputElement;
    destination.value = '/data/typed/';
    destination.dispatchEvent(new Event('input'));
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await wait();
    fixture.detectChanges();
    expect(destination.value).toBe('/data/saved');
    expect(filingExample).toHaveBeenLastCalledWith('/data/saved');
    expect(text(root.querySelector('[data-testid="filing-example"]'))).toContain(
      'is filed at /data/saved/S/T/T.mp4',
    );
  });

  it('asks for SABnzbd first when it isn’t ready', async () => {
    const { root } = await render({ ready: false });
    expect(text(root)).toContain('Save & Test SABnzbd above first.');
  });

  it('saves what you changed', async () => {
    const { fixture, root, api, notifications, input } = await render();
    api.update.mockReturnValue(of(settings({ enabled: true, importMode: 'copy' })));

    const enabled = input('enabled') as HTMLInputElement;
    enabled.checked = true;
    enabled.dispatchEvent(new Event('change'));
    const mode = input('importMode');
    mode.value = 'copy';
    mode.dispatchEvent(new Event('change'));
    const destination = input('destination');
    destination.value = ' /data/downloads/new ';
    destination.dispatchEvent(new Event('input'));
    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(api.update).toHaveBeenCalledWith({
      enabled: true,
      category: 'stashboard',
      destination: '/data/downloads/new',
      sabPathFrom: '/downloads',
      sabPathTo: '/mnt/downloads',
      importMode: 'copy',
      dropIns: false,
      sabManualJobs: true,
    });
    expect(notifications.success).toHaveBeenCalledWith('Finished downloads is on');
  });

  it('turns drop-ins on, saying which folder they come from', async () => {
    const { fixture, root, api, input } = await render();
    api.update.mockReturnValue(of(settings({ dropIns: true })));

    const toggle = input('dropIns') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(text(toggle.closest('.drop-ins'))).toContain(
      'Also bring in files I put in this folder Videos you drop into /mnt/downloads/complete/stashboard-downloads are moved in',
    );
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ dropIns: true }));
  });

  it('shows the switch for downloads added in SABnzbd next to drop-ins, and saves it', async () => {
    const { fixture, root, api, input } = await render();
    api.update.mockReturnValue(of(settings({ sabManualJobs: false })));

    const toggle = input('sabManualJobs') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    const row = toggle.closest('.sab-manual');
    expect(row?.previousElementSibling?.querySelector('input[name="dropIns"]')).not.toBeNull();
    expect(text(row)).toContain(
      'Also bring in downloads I add to this category in SABnzbd myself Downloads you add in SABnzbd under “stashboard” are moved in',
    );
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ sabManualJobs: false }));
  });

  it('shows it off when it was turned off', async () => {
    const { input } = await render({ loaded: settings({ sabManualJobs: false }) });
    expect((input('sabManualJobs') as HTMLInputElement).checked).toBe(false);
  });

  it('names the category when SABnzbd doesn’t say where its folder is', async () => {
    const { root } = await render({ loaded: settings({ dropInFolder: null }) });
    expect(text(root.querySelector('.drop-ins'))).toContain(
      'Videos you drop into SABnzbd’s “stashboard” folder',
    );
  });

  it('links to the Processing page instead of listing downloads here', async () => {
    const { root } = await render();
    const link = root.querySelector('[data-testid="finished-downloads-processing"]');
    expect(link?.getAttribute('href')).toBe('/processing');
    expect(root.querySelector('.handoff')).toBeNull();
  });

  it('shows why a save was refused', async () => {
    const { fixture, root, api } = await render();
    api.update.mockReturnValue(
      throwError(() => ({
        error: { message: 'Pick a folder inside one of Stash’s library folders (/data).' },
      })),
    );

    (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(text(root.querySelector('.save-error'))).toContain(
      'Pick a folder inside one of Stash’s library folders',
    );
  });
});
