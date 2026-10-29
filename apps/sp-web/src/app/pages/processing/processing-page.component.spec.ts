import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DownloadHandoffApiService,
  DropInWatchStatus,
  Processing,
  ProcessingDropIn,
  ProcessingHandoff,
} from '../../core/api/download-handoff.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { ProcessingPageComponent } from './processing-page.component';
import { fileSize, relativeTime } from './processing.format';

const NOW = '2026-10-22T10:00:00.000Z';

function handoff(overrides: Partial<ProcessingHandoff> = {}): ProcessingHandoff {
  return {
    id: 'h1',
    source: 'stashboard',
    sceneId: 'scene-1',
    provider: 'STASHDB',
    releaseTitle: 'Jane.Doe.Beach.Day.1080p',
    status: 'downloading',
    error: null,
    finalPath: null,
    stashSceneId: null,
    createdAt: NOW,
    updatedAt: NOW,
    stage: 'downloading',
    progress: 42,
    timeLeft: '0:05:00',
    detail: null,
    canRetry: false,
    canIgnore: true,
    ...overrides,
  };
}

function dropIn(overrides: Partial<ProcessingDropIn> = {}): ProcessingDropIn {
  return {
    id: 'd1',
    sourcePath: '/downloads/complete/stashboard-downloads/Clip.mp4',
    name: 'Clip.mp4',
    status: 'imported',
    error: null,
    finalPath: '/data/fansdb/Clip.mp4',
    stashSceneId: '88',
    createdAt: NOW,
    updatedAt: NOW,
    canRetry: false,
    ...overrides,
  };
}

function watch(overrides: Partial<DropInWatchStatus> = {}): DropInWatchStatus {
  return {
    state: 'watching',
    reason: null,
    message: null,
    hint: null,
    category: 'stashboard',
    folder: '/mnt/sab/complete/stashboard-downloads',
    sabFolder: '/downloads/complete/stashboard-downloads',
    checking: false,
    lastCheckAt: NOW,
    lastResult: 'No new videos.',
    nextCheckAt: NOW,
    settleSeconds: 45,
    settling: [],
    skipped: [],
    lastError: null,
    ...overrides,
  };
}

function processing(overrides: Partial<Processing> = {}): Processing {
  return {
    handoff: {
      enabled: true,
      sabnzbdReady: true,
      category: 'stashboard',
      sabnzbdUnreachable: false,
    },
    handoffs: [],
    recentHandoffs: [],
    dropIns: { watch: watch(), active: [], recent: [] },
    activeCount: 0,
    problemCount: 0,
    ...overrides,
  };
}

function text(element: Element | null | undefined): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

async function render(data: Processing) {
  const api = {
    processing: vi.fn().mockReturnValue(of(data)),
    checkDropIns: vi.fn().mockReturnValue(of(data)),
    retryHandoff: vi.fn().mockReturnValue(of(data)),
    retryDropIn: vi.fn().mockReturnValue(of(data)),
    ignore: vi.fn().mockReturnValue(of({})),
  };
  const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [ProcessingPageComponent],
    providers: [
      provideRouter([]),
      { provide: DownloadHandoffApiService, useValue: api },
      { provide: AppNotificationsService, useValue: notifications },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(ProcessingPageComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, api, notifications };
}

describe('ProcessingPageComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('shows downloads in SABnzbd with their stage and progress', async () => {
    const { root, api, fixture } = await render(
      processing({
        handoffs: [handoff()],
        recentHandoffs: [
          handoff({
            id: 'h2',
            releaseTitle: 'Other.Release',
            status: 'failed',
            stage: 'failed',
            detail: 'SABnzbd couldn’t download it: Out of retention.',
            progress: null,
            canRetry: true,
            canIgnore: false,
          }),
        ],
      }),
    );

    const item = root.querySelector('[data-testid="handoff"]');
    expect(text(item?.querySelector('.item-title'))).toBe('Jane.Doe.Beach.Day.1080p');
    expect(text(item?.querySelector('.stage'))).toBe('Downloading');
    expect(item?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
    expect(text(item?.querySelector('.meta'))).toBe('42% · 5 min left');
    // Queued → Downloading: one step done, one current.
    const steps = [...(item?.querySelectorAll('.steps li') ?? [])].map((step) =>
      step.getAttribute('data-state'),
    );
    expect(steps).toEqual(['done', 'current', 'todo', 'todo', 'todo', 'todo']);

    const failed = root.querySelector('[data-testid="recent-handoff"]');
    expect(text(failed)).toContain('Out of retention');
    (failed?.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(api.retryHandoff).toHaveBeenCalledWith('h2');

    (item?.querySelector('button') as HTMLButtonElement).click();
    expect(api.ignore).toHaveBeenCalledWith('h1');
  });

  it('labels downloads added in SABnzbd by hand, with the same steps and retry', async () => {
    const { root, api, fixture } = await render(
      processing({
        handoffs: [
          handoff({
            id: 'm1',
            source: 'sabnzbd-manual',
            sceneId: null,
            provider: null,
            releaseTitle: 'Manual.Release',
            status: 'completed',
            stage: 'linking',
            progress: null,
            timeLeft: null,
            detail: 'Moved to /data/Manual.mkv; waiting for Stash to pick it up and identify it.',
          }),
          handoff(),
        ],
        recentHandoffs: [
          handoff({
            id: 'm2',
            source: 'sabnzbd-manual',
            sceneId: null,
            provider: null,
            releaseTitle: 'Other.Manual',
            status: 'failed',
            stage: 'failed',
            progress: null,
            detail: 'No video file in …',
            canRetry: true,
            canIgnore: false,
          }),
        ],
      }),
    );

    const [manual, sent] = [...root.querySelectorAll('[data-testid="handoff"]')];
    expect(text(manual.querySelector('[data-testid="added-in-sab"]'))).toBe('Added in SABnzbd');
    expect(sent.querySelector('[data-testid="added-in-sab"]')).toBeNull();
    const steps = [...manual.querySelectorAll('.steps li')].map((step) =>
      step.getAttribute('data-state'),
    );
    expect(steps).toEqual(['done', 'done', 'done', 'done', 'current', 'todo']);
    expect(text(manual)).toContain('identify it');

    const failed = root.querySelector('[data-testid="recent-handoff"]');
    expect(text(failed?.querySelector('[data-testid="added-in-sab"]'))).toBe('Added in SABnzbd');
    (failed?.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(api.retryHandoff).toHaveBeenCalledWith('m2');
  });

  it('says why the drop-in folder isn’t watched, with both paths and a link to settings', async () => {
    const { root } = await render(
      processing({
        dropIns: {
          watch: watch({
            state: 'problem',
            reason: 'folder-unreadable',
            message:
              'Stashboard can’t open the drop-in folder /mnt/sab/complete/stashboard-downloads (SABnzbd calls it /downloads/complete/stashboard-downloads): it doesn’t exist inside Stashboard’s container.',
            hint: 'Make sure that folder is mounted into Stashboard’s container.',
          }),
          active: [],
          recent: [],
        },
      }),
    );

    const card = root.querySelector('[data-testid="watch-card"]');
    expect(card?.getAttribute('data-state')).toBe('problem');
    expect(text(card?.querySelector('.watch-state'))).toBe('Can’t watch');
    expect(text(card)).toContain('doesn’t exist inside Stashboard’s container');
    expect(text(card)).toContain('mounted into Stashboard’s container');
    expect(text(card)).toContain('/downloads/complete/stashboard-downloads');
    expect(text(card?.querySelector('[data-testid="watch-folder"]'))).toBe(
      '/mnt/sab/complete/stashboard-downloads',
    );
    expect(card?.querySelector('a[href="/settings/integrations"]')).not.toBeNull();
  });

  it('lists files settling, brought in, failed and left alone', async () => {
    const { root, api, fixture } = await render(
      processing({
        dropIns: {
          watch: watch({
            settling: [
              {
                path: '/mnt/sab/complete/stashboard-downloads/New.mp4',
                name: 'New.mp4',
                size: 1_572_864,
                firstSeenAt: NOW,
                unchangedSince: NOW,
              },
            ],
            skipped: [
              {
                path: '/mnt/sab/complete/stashboard-downloads/Sample.mp4',
                name: 'Sample.mp4',
                reason: 'sample',
                detail: 'Looks like a sample.',
              },
            ],
          }),
          active: [dropIn({ id: 'd3', status: 'placed', name: 'Waiting.mp4' })],
          recent: [
            dropIn(),
            dropIn({
              id: 'd2',
              name: 'Taken.mp4',
              status: 'failed',
              error: 'Something is already at /data/fansdb/Taken.mp4.',
              canRetry: true,
            }),
          ],
        },
      }),
    );

    expect(text(root.querySelector('[data-testid="settling"]'))).toContain('1.5 MB');
    expect(text(root.querySelector('[data-testid="settling"]'))).toContain('45 s');
    expect(text(root.querySelector('[data-testid="drop-in-active"]'))).toContain('Waiting.mp4');
    expect(text(root.querySelector('[data-testid="drop-in-done"]'))).toContain('Clip.mp4');
    expect(text(root.querySelector('[data-testid="skipped"]'))).toContain('Looks like a sample.');
    const failed = root.querySelector('[data-testid="drop-in-failed"]');
    expect(text(failed)).toContain('Something is already at');
    (failed?.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(api.retryDropIn).toHaveBeenCalledWith('d2');
  });

  it('checks the folder now on request', async () => {
    const { root, api, fixture, notifications } = await render(processing());
    (root.querySelector('[data-testid="check-now"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(api.checkDropIns).toHaveBeenCalledTimes(1);

    api.checkDropIns.mockReturnValue(throwError(() => ({ error: { message: 'Nope' } })));
    (root.querySelector('[data-testid="check-now"]') as HTMLButtonElement).click();
    expect(notifications.error).toHaveBeenCalledWith('Couldn’t check the folder', 'Nope');
  });

  it('says when there’s nothing downloading and when Finished downloads is off', async () => {
    const { root } = await render(
      processing({
        handoff: {
          enabled: false,
          sabnzbdReady: true,
          category: 'stashboard',
          sabnzbdUnreachable: false,
        },
      }),
    );
    expect(text(root.querySelector('[data-testid="no-downloads"]'))).toBe(
      'Nothing downloading right now.',
    );
    expect(text(root)).toContain('Finished downloads is off');
    expect(root.querySelector('a[href="/acquisition"]')).not.toBeNull();
  });

  it('refreshes every few seconds, and stops while the page is hidden', async () => {
    vi.useFakeTimers();
    const { api, fixture } = await render(processing());
    expect(api.processing).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.processing).toHaveBeenCalledTimes(2);

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.processing).toHaveBeenCalledTimes(2);

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.processing).toHaveBeenCalledTimes(3);
    visibility.mockRestore();
    fixture.destroy();
  });
});

describe('processing format', () => {
  it('says how long ago or until', () => {
    const now = Date.parse(NOW);
    expect(relativeTime(NOW, now)).toBe('just now');
    expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe('30 s ago');
    expect(relativeTime(new Date(now + 120_000).toISOString(), now)).toBe('in 2 min');
    expect(relativeTime(null, now)).toBeNull();
  });

  it('writes sizes plainly', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(1_572_864)).toBe('1.5 MB');
    expect(fileSize(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(fileSize(null)).toBeNull();
  });
});
