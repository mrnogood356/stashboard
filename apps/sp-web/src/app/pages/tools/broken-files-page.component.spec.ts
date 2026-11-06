import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
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
  return { fixture, root: fixture.nativeElement as HTMLElement };
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
        { kind: 'no-cover', count: 3, scenes: scenes(3) },
        { kind: 'no-fingerprint', count: 120, scenes: scenes(50) },
        {
          kind: 'no-marker-preview',
          count: 7,
          scenes: [{ id: '9', title: 'Chaptered', path: null, markers: 7 }],
        },
      ],
      { startJob, generateFor },
    );
    const button = (id: string) => root.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

    expect(root.querySelector('[data-testid="problem-no-length"]')).toBeNull();
    expect(root.textContent).toContain('And 70 more.');
    expect(root.textContent).toContain('7 chapters');

    // A few scenes: Generate for just them. Many: for the library.
    button('fix-no-cover-generate').click();
    expect(generateFor).toHaveBeenCalledWith(['1', '2', '3']);
    button('fix-no-fingerprint-generate').click();
    expect(startJob).toHaveBeenCalledWith('generate');
    button('fix-no-marker-preview-generate').click();
    expect(generateFor).toHaveBeenCalledWith(['9']);

    fixture.detectChanges();
    expect(button('fix-no-cover-generate').textContent).toContain('Started');
    expect(startJob).not.toHaveBeenCalledWith('clean');

    // Look again: anything still listed can be fixed again.
    button('fix-no-cover-generate')
      .closest('main')!
      .querySelector<HTMLButtonElement>('.head-action')!
      .click();
    fixture.detectChanges();
    expect(button('fix-no-cover-generate').disabled).toBe(false);
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
      { kind: 'no-cover', count: 0, scenes: [] },
      { kind: 'no-fingerprint', count: 0, scenes: [] },
      { kind: 'no-marker-preview', count: 0, scenes: [] },
    ]);
    expect(root.textContent).toContain('Nothing broken');
  });

  it('shows the quick lists at once and the chapter check when it finishes', async () => {
    vi.useFakeTimers();
    try {
      const checking: ProblemList[] = [
        { kind: 'no-file', count: 1, scenes: scenes(1) },
        { kind: 'no-marker-preview', count: null, scenes: [], checking: true },
      ];
      const done: ProblemList[] = [
        { kind: 'no-file', count: 1, scenes: scenes(1) },
        { kind: 'no-marker-preview', count: 2, scenes: scenes(2) },
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
        root.querySelector('[data-testid="problem-no-marker-preview"] .count-badge')?.textContent,
      ).toContain('2');
      // Done: no more asking.
      vi.advanceTimersByTime(20000);
      expect(problems).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
