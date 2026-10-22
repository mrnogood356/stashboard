import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SceneTimeline,
  TimelineAction,
  TimelineApiService,
  timelineTone,
} from '../../core/api/timeline.service';
import { SceneTimelineComponent } from './scene-timeline.component';

function timeline(overrides: Partial<SceneTimeline> = {}): SceneTimeline {
  return {
    stashId: 'sdb-1',
    route: 'whisparr',
    now: 'Download failed',
    unknown: [],
    checkedAt: '2026-10-21T12:00:00.000Z',
    steps: [
      {
        step: 'requested',
        label: 'Requested',
        at: '2026-10-20T09:00:00.000Z',
        status: 'done',
        detail: 'Requested in Whisparr.',
        progress: null,
        action: null,
      },
      {
        step: 'grabbed',
        label: 'Grabbed',
        at: null,
        status: 'done',
        detail: 'Bright.Summer.Afternoon.1080p · NZBgeek',
        progress: null,
        action: null,
      },
      {
        step: 'downloading',
        label: 'Downloading',
        at: null,
        status: 'failed',
        detail: 'Whisparr says: Unpacking failed',
        progress: null,
        action: { kind: 'pick-release', label: 'Pick another release' },
      },
    ],
    ...overrides,
  };
}

describe('SceneTimelineComponent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  async function render(
    options: { scene?: ReturnType<typeof vi.fn>; heading?: boolean; observe?: boolean } = {},
  ) {
    // Without IntersectionObserver (as in jsdom) it loads straight away.
    let reveal: (() => void) | null = null;
    if (options.observe) {
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
            reveal = () => callback([{ isIntersecting: true }]);
          }
          observe = vi.fn();
          disconnect = vi.fn();
        },
      );
    }
    const api = { scene: options.scene ?? vi.fn().mockReturnValue(of(timeline())) };
    await TestBed.configureTestingModule({
      imports: [SceneTimelineComponent],
      providers: [provideRouter([]), { provide: TimelineApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(SceneTimelineComponent);
    fixture.componentRef.setInput('stashId', 'sdb-1');
    if (options.heading !== undefined) {
      fixture.componentRef.setInput('heading', options.heading);
    }
    fixture.detectChanges();
    return {
      fixture,
      api,
      root: fixture.nativeElement as HTMLElement,
      reveal: () => {
        reveal?.();
        fixture.detectChanges();
      },
    };
  }

  it('tells the story step by step, with the stuck step’s reason and what to do', async () => {
    const { root, api } = await render();

    expect(api.scene).toHaveBeenCalledWith('sdb-1');
    expect(root.querySelector('.timeline-now')?.textContent).toContain('Download failed');
    const steps = [...root.querySelectorAll('.timeline-step')];
    expect(steps.map((step) => step.getAttribute('data-status'))).toEqual([
      'done',
      'done',
      'failed',
    ]);
    expect(steps[1].textContent).toContain('Bright.Summer.Afternoon.1080p · NZBgeek');
    expect(steps[2].textContent).toContain('Stuck');
    expect(steps[2].textContent).toContain('Whisparr says: Unpacking failed');
    expect(steps[0].querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-20T09:00:00.000Z',
    );
  });

  it('only asks once it scrolls into view', async () => {
    const { api, reveal, root } = await render({ observe: true });

    expect(api.scene).not.toHaveBeenCalled();
    expect(root.textContent).toContain('Checking where it is');
    reveal();
    expect(api.scene).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll('.timeline-step')).toHaveLength(3);
  });

  it('hands “Pick another release” and “Details” to the page', async () => {
    const { fixture, root } = await render();
    const acted: TimelineAction[] = [];
    let details = 0;
    fixture.componentInstance.act.subscribe((action) => acted.push(action));
    fixture.componentInstance.details.subscribe(() => details++);

    root.querySelector<HTMLButtonElement>('[data-testid="timeline-action-pick-release"]')!.click();
    root.querySelector<HTMLButtonElement>('.timeline-link')!.click();

    expect(acted).toEqual([{ kind: 'pick-release', label: 'Pick another release' }]);
    expect(details).toBe(1);
  });

  it('links Library Tools actions, and shows download progress', async () => {
    const { root } = await render({
      scene: vi.fn().mockReturnValue(
        of(
          timeline({
            now: 'Downloading · 42%',
            steps: [
              {
                step: 'downloading',
                label: 'Downloading',
                at: null,
                status: 'current',
                detail: '42% · about 13 min left',
                progress: 42,
                action: null,
              },
              {
                step: 'matched',
                label: 'Matched',
                at: null,
                status: 'failed',
                detail: 'Stash has the file, but it isn’t linked yet.',
                progress: null,
                action: { kind: 'check-matches', label: 'Check these matches' },
              },
            ],
          }),
        ),
      ),
    });

    expect(root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
    const link = root.querySelector<HTMLAnchorElement>('a.timeline-action');
    expect(link?.textContent).toContain('Check these matches');
    expect(link?.getAttribute('href')).toBe('/tools/organize');
  });

  it('says which sources couldn’t be asked', async () => {
    const { root } = await render({
      scene: vi.fn().mockReturnValue(of(timeline({ unknown: ['Whisparr', 'Stash'] }))),
    });

    expect(root.textContent).toContain(
      'Couldn’t ask Whisparr or Stash, so some steps are unknown.',
    );
  });

  it('fails soft and can try again', async () => {
    const scene = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('offline')))
      .mockReturnValue(of(timeline()));
    const { root, fixture } = await render({ scene });

    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Couldn’t get the timeline',
    );
    root.querySelector<HTMLButtonElement>('.app-btn')!.click();
    fixture.detectChanges();
    expect(root.querySelectorAll('.timeline-step')).toHaveLength(3);
  });

  it('leaves out its heading and one-liner inside a card', async () => {
    const { root } = await render({ heading: false });

    expect(root.querySelector('h2')).toBeNull();
    expect(root.querySelector('.timeline-now')).toBeNull();
    expect(root.querySelector('.timeline-link')?.textContent).toContain('Details');
  });
});

describe('timelineTone', () => {
  it('is failed when any step is stuck, current while one is on the way', () => {
    expect(timelineTone(timeline())).toBe('failed');
    expect(
      timelineTone(
        timeline({
          steps: [{ ...timeline().steps[0], status: 'current' }],
        }),
      ),
    ).toBe('current');
    expect(timelineTone(timeline({ steps: [timeline().steps[0]] }))).toBe('done');
  });
});
