import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { DownloadHandoffApiService, Processing } from '../../core/api/download-handoff.service';
import { ProcessingCardComponent } from './processing-card.component';

const NOW = '2026-10-22T10:00:00.000Z';

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
    dropIns: {
      watch: {
        state: 'watching',
        reason: null,
        message: null,
        hint: null,
        category: 'stashboard',
        folder: '/sab',
        sabFolder: '/sab',
        checking: false,
        lastCheckAt: NOW,
        lastResult: null,
        nextCheckAt: NOW,
        settleSeconds: 45,
        settling: [],
        skipped: [],
        lastError: null,
      },
      active: [],
      recent: [],
    },
    activeCount: 0,
    problemCount: 0,
    ...overrides,
  };
}

async function render(source: ReturnType<DownloadHandoffApiService['processing']>) {
  await TestBed.configureTestingModule({
    imports: [ProcessingCardComponent],
    providers: [
      provideRouter([]),
      { provide: DownloadHandoffApiService, useValue: { processing: () => source } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(ProcessingCardComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ProcessingCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('hides when nothing is on its way in', async () => {
    const root = await render(of(processing()));
    expect(root.querySelector('[data-testid="processing-card"]')).toBeNull();
  });

  it('hides when the page can’t be loaded', async () => {
    const root = await render(throwError(() => new Error('down')));
    expect(root.querySelector('[data-testid="processing-card"]')).toBeNull();
  });

  it('shows the count and the first few items, linking to Processing', async () => {
    const base = processing();
    const root = await render(
      of(
        processing({
          activeCount: 4,
          handoffs: [
            {
              id: 'h1',
              source: 'stashboard',
              sceneId: 's',
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
              timeLeft: null,
              detail: null,
              canRetry: false,
              canIgnore: true,
            },
          ],
          dropIns: {
            ...base.dropIns,
            watch: {
              ...base.dropIns.watch,
              settling: [
                {
                  path: '/sab/New.mp4',
                  name: 'New.mp4',
                  size: 1,
                  firstSeenAt: NOW,
                  unchangedSince: null,
                },
              ],
            },
            active: [
              {
                id: 'd1',
                sourcePath: '/sab/Old.mp4',
                name: 'Old.mp4',
                status: 'placed',
                error: null,
                finalPath: '/data/Old.mp4',
                stashSceneId: null,
                createdAt: NOW,
                updatedAt: NOW,
                canRetry: false,
              },
              {
                id: 'd2',
                sourcePath: '/sab/Fourth.mp4',
                name: 'Fourth.mp4',
                status: 'placed',
                error: null,
                finalPath: '/data/Fourth.mp4',
                stashSceneId: null,
                createdAt: NOW,
                updatedAt: NOW,
                canRetry: false,
              },
            ],
          },
        }),
      ),
    );

    const card = root.querySelector('[data-testid="processing-card"]');
    expect(card?.querySelector('a')?.getAttribute('href')).toBe('/processing');
    expect(card?.querySelector('.processing-card-count')?.textContent?.trim()).toBe('4');
    const items = [...(card?.querySelectorAll('.processing-card-item') ?? [])].map((item) =>
      [...item.children].map((part) => part.textContent?.trim()).join(' '),
    );
    expect(items).toEqual([
      'Jane.Doe.Beach.Day.1080p 42%',
      'New.mp4 Settling',
      'Old.mp4 Waiting for Stash',
    ]);
  });
});
