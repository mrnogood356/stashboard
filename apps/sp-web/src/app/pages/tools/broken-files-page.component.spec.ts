import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LocalLibraryService, ProblemList } from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { BrokenFilesPageComponent } from './broken-files-page.component';

const scenes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i + 1), title: `Scene ${i + 1}`, path: null }));

async function render(lists: ProblemList[], library: Record<string, unknown> = {}) {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [BrokenFilesPageComponent],
    providers: [
      provideRouter([]),
      { provide: LocalLibraryService, useValue: { problems: () => of(lists), ...library } },
      {
        provide: AppNotificationsService,
        useValue: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(BrokenFilesPageComponent);
  fixture.detectChanges();
  return {
    fixture,
    root: fixture.nativeElement as HTMLElement,
    notifications: TestBed.inject(AppNotificationsService) as unknown as Record<
      'success' | 'info',
      ReturnType<typeof vi.fn>
    >,
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

describe('BrokenFilesPageComponent', () => {
  it('lists only kinds with problems, each with its fixes', async () => {
    const startJob = vi.fn().mockReturnValue(of({ jobId: '1' }));
    const generateFor = vi.fn().mockReturnValue(of({ jobId: '2' }));
    const { fixture, root } = await render(
      [
        { kind: 'no-file', count: 2, scenes: scenes(2) },
        { kind: 'no-length', count: 0, scenes: [] },
        { kind: 'unreadable', count: 120, scenes: scenes(50) },
        {
          kind: 'generate',
          count: 3,
          scenes: scenes(3).map((scene) => ({ ...scene, problems: ['No hover preview.'] })),
        },
      ],
      { startJob, generateFor },
    );
    const button = (id: string) => root.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

    expect(root.querySelector('[data-testid="problem-no-length"]')).toBeNull();
    expect(root.textContent).toContain('And 70 more.');
    expect(root.querySelector('[data-testid="why-2"]')?.textContent).toContain('No hover preview.');

    // A few scenes: Generate for just them.
    button('fix-generate-generate').click();
    expect(generateFor).toHaveBeenCalledWith(['1', '2', '3']);
    button('fix-unreadable-scan').click();
    expect(startJob).toHaveBeenCalledWith('scan');

    fixture.detectChanges();
    expect(button('fix-generate-generate').textContent).toContain('Started');
    expect(startJob).not.toHaveBeenCalledWith('clean');

    // Look again: anything still listed can be fixed again.
    button('fix-generate-generate')
      .closest('main')!
      .querySelector<HTMLButtonElement>('.head-action')!
      .click();
    fixture.detectChanges();
    expect(button('fix-generate-generate').disabled).toBe(false);
  });

  it('says what was left out when Generate started with a note', async () => {
    const generateFor = vi
      .fn()
      .mockReturnValue(of({ jobId: '2', warning: '1 scene couldn’t be made again.' }));
    const { root, notifications } = await render(
      [{ kind: 'generate', count: 1, scenes: scenes(1) }],
      { generateFor },
    );
    root.querySelector<HTMLButtonElement>('[data-testid="fix-generate-generate"]')!.click();
    expect(notifications.info).toHaveBeenCalledWith(
      'Started in Stash, with a note',
      '1 scene couldn’t be made again.',
    );
    expect(notifications.success).not.toHaveBeenCalled();
  });

  it('says it’s working while Stash is asked, then started', async () => {
    const reply = new Subject<{ jobId: string }>();
    const generateFor = vi.fn().mockReturnValue(reply);
    const { fixture, root, notifications } = await render(
      [{ kind: 'generate', count: 1, scenes: scenes(1) }],
      { generateFor },
    );
    const button = () =>
      root.querySelector<HTMLButtonElement>('[data-testid="fix-generate-generate"]')!;
    button().click();
    fixture.detectChanges();
    expect(button().textContent).toContain('Working');
    expect(button().disabled).toBe(true);
    reply.next({ jobId: '2' });
    fixture.detectChanges();
    expect(button().textContent).toContain('Started');
    // Followed on the page rather than "go and check Stash jobs".
    expect(notifications.success).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="following"]')?.textContent).toContain(
      'Generating in Stash',
    );
  });

  it('follows the job it started and reads the list again once Stash is done', async () => {
    vi.useFakeTimers();
    try {
      const problems = vi
        .fn()
        .mockReturnValueOnce(of([{ kind: 'generate', count: 1, scenes: scenes(1) }]))
        .mockReturnValueOnce(of([{ kind: 'generate', count: 0, scenes: [] }]));
      // Generate still running, then the rescan Stashboard asked for, then nothing.
      const jobs = vi
        .fn()
        .mockReturnValueOnce(of([{ id: '2', status: 'RUNNING' }]))
        .mockReturnValueOnce(of([{ id: '3', status: 'READY', byStashboard: true }]))
        .mockReturnValueOnce(of([{ id: '9', status: 'RUNNING', byStashboard: false }]));
      const generateFor = vi.fn().mockReturnValue(of({ jobId: '2' }));
      const { fixture, root, notifications } = await render([], { problems, jobs, generateFor });
      root.querySelector<HTMLButtonElement>('[data-testid="fix-generate-generate"]')!.click();
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="following"]')).not.toBeNull();

      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(5000);
      expect(problems).toHaveBeenCalledTimes(1);
      // Someone else's job doesn't hold it up.
      vi.advanceTimersByTime(5000);
      fixture.detectChanges();
      expect(jobs).toHaveBeenCalledTimes(3);
      expect(problems).toHaveBeenCalledTimes(2);
      expect(problems).toHaveBeenLastCalledWith(true);
      expect(notifications.success).toHaveBeenCalledWith(
        'Generate is done',
        'The list is up to date.',
      );
      expect(root.querySelector('[data-testid="following"]')).toBeNull();
      expect(root.querySelector('[data-testid="problem-generate"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a scene on its list, and shows skipped scenes again', async () => {
    const skipProblem = vi.fn().mockReturnValue(of(undefined));
    const clearProblemSkips = vi.fn().mockReturnValue(of(undefined));
    const problems = vi
      .fn()
      .mockReturnValueOnce(
        of([
          {
            kind: 'generate',
            count: 2,
            scenes: scenes(2),
            skipped: 1,
          },
        ]),
      )
      .mockReturnValue(of([{ kind: 'generate', count: 3, scenes: scenes(3) }]));
    const { fixture, root } = await render([], { problems, skipProblem, clearProblemSkips });
    expect(root.querySelector('[data-testid="skipped-note"]')?.textContent).toContain(
      '1 scene skipped',
    );

    root.querySelector<HTMLButtonElement>('[data-testid="skip-generate-2"]')!.click();
    fixture.detectChanges();
    expect(skipProblem).toHaveBeenCalledWith('generate', '2');
    expect(root.querySelector('[data-testid="why-2"], [data-testid="skip-generate-2"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="problem-generate"] .count-badge')?.textContent,
    ).toContain('1');
    expect(root.querySelector('[data-testid="skipped-note"]')?.textContent).toContain(
      '2 scenes skipped',
    );

    Array.from(root.querySelectorAll<HTMLButtonElement>('.skipped-note button'))[0].click();
    fixture.detectChanges();
    expect(clearProblemSkips).toHaveBeenCalled();
    expect(root.querySelector('[data-testid="skipped-note"]')).toBeNull();
    expect(root.querySelectorAll('[data-testid="problem-generate"] .scenes > li').length).toBe(3);
  });

  it('removes scenes with no file from Stash after a second tap, and deletes broken files but never a scene with more files', async () => {
    const deleteScene = vi.fn().mockReturnValue(of(undefined));
    const multi = { id: '3', title: 'Two files', path: '/x', fileCount: 2 };
    const { fixture, root } = await render(
      [
        { kind: 'no-file', count: 2, scenes: scenes(2) },
        { kind: 'no-length', count: 2, scenes: [{ ...scenes(1)[0], id: '5' }, multi] },
      ],
      { deleteScene },
    );
    const button = (id: string) => root.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

    button('fix-no-file-remove').click();
    fixture.detectChanges();
    expect(deleteScene).not.toHaveBeenCalled();
    expect(button('fix-no-file-remove').textContent).toContain('Tap again');
    button('fix-no-file-remove').click();
    await settle();
    fixture.detectChanges();
    expect(deleteScene.mock.calls).toEqual([
      ['1', false, false],
      ['2', false, false],
    ]);
    expect(root.querySelector('[data-testid="problem-no-file"] .scenes li')).toBeNull();

    button('fix-no-length-delete-files').click();
    fixture.detectChanges();
    button('fix-no-length-delete-files').click();
    await settle();
    expect(deleteScene).toHaveBeenLastCalledWith('5', true, true);
    expect(deleteScene).not.toHaveBeenCalledWith('3', true, true);
  });

  it('says so when nothing is broken', async () => {
    const { root } = await render([
      { kind: 'no-file', count: 0, scenes: [] },
      { kind: 'no-length', count: 0, scenes: [] },
      { kind: 'unreadable', count: 0, scenes: [] },
      { kind: 'file-check', count: 0, scenes: [] },
      { kind: 'generate', count: 0, scenes: [] },
    ]);
    expect(root.textContent).toContain('Nothing broken');
  });

  it('shows the quick lists at once and the chapter check when it finishes', async () => {
    vi.useFakeTimers();
    try {
      const checking: ProblemList[] = [
        { kind: 'no-file', count: 1, scenes: scenes(1) },
        { kind: 'generate', count: null, scenes: [], checking: true },
      ];
      const done: ProblemList[] = [
        { kind: 'no-file', count: 1, scenes: scenes(1) },
        { kind: 'generate', count: 2, scenes: scenes(2) },
      ];
      const problems = vi.fn().mockReturnValueOnce(of(checking)).mockReturnValue(of(done));
      const { fixture, root } = await render([], { problems });
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="problem-no-file"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="checking"]')).not.toBeNull();

      vi.advanceTimersByTime(5000);
      fixture.detectChanges();
      expect(problems).toHaveBeenCalledTimes(2);
      expect(root.querySelector('[data-testid="checking"]')).toBeNull();
      expect(
        root.querySelector('[data-testid="problem-generate"] .count-badge')?.textContent,
      ).toContain('2');
      // Done: no more asking.
      vi.advanceTimersByTime(20000);
      expect(problems).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the check under way, not a Generate for nothing, while an earlier 0 is checked again', async () => {
    const { fixture, root } = await render([
      { kind: 'no-file', count: 1, scenes: scenes(1) },
      { kind: 'generate', count: 0, scenes: [], checking: true },
    ]);
    fixture.detectChanges();
    const panel = root.querySelector('[data-testid="problem-generate"]')!;
    expect(panel.querySelector('[data-testid="checking"]')).not.toBeNull();
    expect(panel.querySelector('button')).toBeNull();
    fixture.destroy();
  });

  it('says what’s wrong with each file on disk, with Scan again', async () => {
    const startJob = vi.fn(() => of({ jobId: '3' }));
    const { fixture, root } = await render(
      [
        {
          kind: 'file-check',
          count: 1,
          scenes: [
            {
              id: '5',
              title: 'Cut off',
              path: '/data/cut.mp4',
              problems: ['It’s 1.2 GB smaller than when Stash scanned it.'],
            },
          ],
        },
      ],
      { startJob },
    );
    fixture.detectChanges();
    const panel = root.querySelector('[data-testid="problem-file-check"]')!;
    expect(panel.textContent).toContain('Files missing, damaged or changed on disk');
    expect(panel.querySelector('[data-testid="why-5"]')?.textContent).toContain('1.2 GB smaller');
    (panel.querySelector('[data-testid="fix-file-check-scan"]') as HTMLButtonElement).click();
    expect(startJob).toHaveBeenCalledWith('scan');
  });

  it('says why a count is unknown', async () => {
    const { fixture, root } = await render([
      {
        kind: 'generate',
        count: null,
        scenes: [],
        unanswered: 9,
        note: 'Stash didn’t answer for 9 of 9 chapters (HTTP 401), so they couldn’t be counted.',
      },
    ]);
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="unknown"]')?.textContent).toContain('(HTTP 401)');
  });

  it('says how many chapters Stash didn’t answer for', async () => {
    const { fixture, root } = await render([
      { kind: 'generate', count: 2, scenes: scenes(1), unanswered: 5, unansweredWhy: 'timed out' },
    ]);
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="unanswered"]')?.textContent).toContain(
      '5 more files couldn’t be checked (timed out)',
    );
  });

  it('drops a request still under way when the page closes, so polling doesn’t start again', async () => {
    vi.useFakeTimers();
    try {
      const reply = new Subject<ProblemList[]>();
      const problems = vi
        .fn()
        .mockReturnValueOnce(of([{ kind: 'generate', count: null, scenes: [], checking: true }]))
        .mockReturnValueOnce(reply)
        .mockReturnValue(NEVER);
      const { fixture } = await render([], { problems });
      vi.advanceTimersByTime(5000);
      expect(problems).toHaveBeenCalledTimes(2);
      fixture.destroy();
      expect(reply.observed).toBe(false);
      vi.advanceTimersByTime(60000);
      expect(problems).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
