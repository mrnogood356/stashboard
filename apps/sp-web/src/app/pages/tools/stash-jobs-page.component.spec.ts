import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalLibraryService, StashJob } from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { StashJobsPageComponent } from './stash-jobs-page.component';

function job(id: string, status: string, progress: number | null = null): StashJob {
  return {
    id,
    status,
    description: `Job ${id}`,
    progress,
    subTasks: [],
    addTime: null,
    startTime: null,
  };
}

function render(library: Record<string, unknown>) {
  const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  TestBed.configureTestingModule({
    imports: [StashJobsPageComponent],
    providers: [
      provideRouter([]),
      { provide: LocalLibraryService, useValue: library },
      { provide: AppNotificationsService, useValue: notifications },
    ],
  });
  const fixture = TestBed.createComponent(StashJobsPageComponent);
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, notifications };
}

function task(root: HTMLElement, title: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.task')).find((button) =>
    button.textContent?.includes(title),
  )!;
}

describe('StashJobsPageComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('says Stash is idle when nothing runs', () => {
    const library = { jobs: vi.fn().mockReturnValue(of([])), startJob: vi.fn(), stopJob: vi.fn() };
    const { fixture, root } = render(library);

    expect(root.textContent).toContain('Nothing running. Stash is idle.');
    expect(root.querySelectorAll('.job').length).toBe(0);
    fixture.destroy();
  });

  it('shows each job state and only offers Stop for running or waiting jobs', () => {
    const library = {
      jobs: vi
        .fn()
        .mockReturnValue(
          of([job('1', 'RUNNING'), job('2', 'READY'), job('3', 'FINISHED', 1), job('4', 'FAILED')]),
        ),
      startJob: vi.fn(),
      stopJob: vi.fn(),
    };
    const { fixture, root } = render(library);

    const rows = Array.from(root.querySelectorAll('.job'));
    expect(rows.map((row) => row.querySelector('.job-status')?.textContent?.trim())).toEqual([
      'Running',
      'Waiting',
      'Done',
      'Failed',
    ]);
    expect(rows.map((row) => row.querySelector('.stop') !== null)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    // A running job without progress gets a moving bar instead of a percentage.
    expect(rows[0].querySelector('.bar.indeterminate')).not.toBeNull();
    expect(rows[2].querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '100',
    );
    fixture.destroy();
  });

  it('shows an error when Stash cannot be reached', () => {
    const library = {
      jobs: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
      startJob: vi.fn(),
      stopJob: vi.fn(),
    };
    const { fixture, root } = render(library);

    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't reach Stash to check its jobs.",
    );
    expect(root.textContent).not.toContain('Stash is idle');
    fixture.destroy();
  });

  it('starts Clean up once you confirm, then checks the jobs again', () => {
    const library = {
      jobs: vi.fn().mockReturnValue(of([])),
      startJob: vi.fn().mockReturnValue(of({ jobId: '9' })),
      stopJob: vi.fn(),
    };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { fixture, root, notifications } = render(library);

    task(root, 'Clean up').click();
    fixture.detectChanges();

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('missing from disk'));
    expect(library.startJob).toHaveBeenCalledWith('clean');
    expect(notifications.success).toHaveBeenCalledWith('Clean up started', expect.any(String));
    expect(library.jobs).toHaveBeenCalledTimes(2);
    fixture.destroy();
  });

  it('does not ask before tasks that are safe, and reports why one could not start', () => {
    const library = {
      jobs: vi.fn().mockReturnValue(of([])),
      startJob: vi
        .fn()
        .mockReturnValue(throwError(() => ({ error: { message: 'Stash is busy' } }))),
      stopJob: vi.fn(),
    };
    const confirm = vi.spyOn(window, 'confirm');
    const { fixture, root, notifications } = render(library);

    task(root, 'Generate').click();
    fixture.detectChanges();

    expect(confirm).not.toHaveBeenCalled();
    expect(library.startJob).toHaveBeenCalledWith('generate');
    expect(notifications.error).toHaveBeenCalledWith("Couldn't start Generate", 'Stash is busy');
    expect(task(root, 'Generate').disabled).toBe(false);
    fixture.destroy();
  });

  it('checks every 2 seconds while jobs run and every 8 seconds when idle', () => {
    vi.useFakeTimers();
    const answers = [[job('1', 'RUNNING', 0.5)], [], []];
    const library = {
      jobs: vi.fn(() => of(answers.shift() ?? [])),
      startJob: vi.fn(),
      stopJob: vi.fn(),
    };
    const { fixture } = render(library);
    expect(library.jobs).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(library.jobs).toHaveBeenCalledTimes(2);

    // Now idle: nothing for almost 8 seconds.
    vi.advanceTimersByTime(7999);
    expect(library.jobs).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(library.jobs).toHaveBeenCalledTimes(3);

    fixture.destroy();
    vi.advanceTimersByTime(60_000);
    expect(library.jobs).toHaveBeenCalledTimes(3);
  });
});
