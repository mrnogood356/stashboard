import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { DuplicatesPageComponent } from './duplicates-page.component';
import { FixLibraryPageComponent } from './fix-library-page.component';
import { StashJobsPageComponent } from './stash-jobs-page.component';

function card(id: string) {
  return {
    id,
    title: `Scene ${id}`,
    imageUrl: null,
    cardImageUrl: null,
    studioId: null,
    studio: 'Studio',
    studioImageUrl: null,
    releaseDate: null,
    duration: null,
    playCount: 0,
    progress: null,
    type: 'SCENE',
    source: 'STASH',
  };
}

async function render<T>(component: Type<T>, library: Record<string, unknown>) {
  const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [component],
    providers: [
      provideRouter([]),
      { provide: LocalLibraryService, useValue: library },
      { provide: AppNotificationsService, useValue: notifications },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, notifications };
}

describe('Library tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('fix my library: shows counts, identifies a scene, and marks one organized', async () => {
    const library = {
      fixCounts: vi.fn().mockReturnValue(of({ unmatched: 2, untagged: 1, unorganized: 1 })),
      fixScenes: vi.fn((kind: string) =>
        of({
          total: 2,
          page: 1,
          hasMore: false,
          items: kind === 'unorganized' ? [card('9')] : [card('1'), card('2')],
        }),
      ),
      identify: vi.fn().mockReturnValue(of({ jobId: '5' })),
      updateScene: vi.fn().mockReturnValue(of({})),
    };
    const { fixture, root, notifications } = await render(FixLibraryPageComponent, library);

    expect(root.textContent).toContain('Not matched');
    expect(root.querySelectorAll('.row').length).toBe(2);
    root.querySelector<HTMLButtonElement>('.row .btn')!.click();
    expect(library.identify).toHaveBeenCalledWith(['1']);
    expect(notifications.success).toHaveBeenCalled();

    root.querySelector<HTMLButtonElement>('.list-head .btn')!.click();
    expect(library.identify).toHaveBeenLastCalledWith(['1', '2']);

    Array.from(root.querySelectorAll<HTMLButtonElement>('.segmented button'))[2].click();
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('.row .btn')!.click();
    fixture.detectChanges();
    expect(library.updateScene).toHaveBeenCalledWith('9', { organized: true });
    expect(root.querySelectorAll('.row').length).toBe(0);
  });

  it('stash jobs: lists running jobs, asks before Clean up, and can stop a job', async () => {
    const library = {
      jobs: vi.fn().mockReturnValue(
        of([
          {
            id: '3',
            status: 'RUNNING',
            description: 'Generating',
            progress: 0.42,
            subTasks: ['Previews'],
            addTime: null,
            startTime: null,
          },
        ]),
      ),
      startJob: vi.fn().mockReturnValue(of({ jobId: '4' })),
      stopJob: vi.fn().mockReturnValue(of(undefined)),
    };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { fixture, root } = await render(StashJobsPageComponent, library);

    expect(root.textContent).toContain('Generating');
    expect(root.querySelector('.bar span')?.getAttribute('style')).toContain('42%');

    const clean = Array.from(root.querySelectorAll<HTMLButtonElement>('.task')).find((button) =>
      button.textContent?.includes('Clean up'),
    )!;
    clean.click();
    expect(confirm).toHaveBeenCalled();
    expect(library.startJob).not.toHaveBeenCalled();

    const scan = Array.from(root.querySelectorAll<HTMLButtonElement>('.task')).find((button) =>
      button.textContent?.includes('Scan'),
    )!;
    scan.click();
    expect(library.startJob).toHaveBeenCalledWith('scan');

    root.querySelector<HTMLButtonElement>('.stop')!.click();
    expect(library.stopJob).toHaveBeenCalledWith('3');
    fixture.destroy();
  });

  it('stash jobs: a new check replaces one still on its way, and leaving stops both', async () => {
    const checks: Array<Subject<unknown[]>> = [];
    const library = {
      jobs: vi.fn(() => {
        const check = new Subject<unknown[]>();
        checks.push(check);
        return check;
      }),
      startJob: vi.fn(),
      stopJob: vi.fn().mockReturnValue(of(undefined)),
    };
    const { fixture } = await render(StashJobsPageComponent, library);

    (fixture.componentInstance as any).poll();

    expect(checks).toHaveLength(2);
    expect(checks[0].observed).toBe(false);
    fixture.destroy();
    expect(checks[1].observed).toBe(false);
  });

  it('duplicates: marks the best copy and removes another one', async () => {
    const file = (width: number, height: number) => ({
      path: '/x',
      basename: `${width}.mp4`,
      size: 1000,
      width,
      height,
      duration: 60,
      videoCodec: 'h264',
      bitRate: 1,
      frameRate: 30,
    });
    const library = {
      duplicates: vi.fn().mockReturnValue(
        of([
          {
            suggestedKeepId: 'a',
            scenes: [
              {
                id: 'a',
                title: 'A',
                date: null,
                studio: null,
                playCount: 0,
                organized: false,
                imageUrl: null,
                file: file(1920, 1080),
              },
              {
                id: 'b',
                title: 'B',
                date: null,
                studio: null,
                playCount: 0,
                organized: false,
                imageUrl: null,
                file: file(1280, 720),
              },
            ],
          },
        ]),
      ),
      deleteScene: vi.fn().mockReturnValue(of(undefined)),
    };
    const { fixture, root } = await render(DuplicatesPageComponent, library);

    expect(root.querySelector('.copy.best')?.textContent).toContain('1080p');
    root.querySelector<HTMLButtonElement>('.copy:not(.best) .btn')!.click();
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('.sheet .btn.danger')!.click();
    fixture.detectChanges();

    expect(library.deleteScene).toHaveBeenCalledWith('b', true);
    expect(root.textContent).toContain('No duplicates found.');
  });

  it('duplicates: shows the groups for the accuracy picked last, whichever answers first', async () => {
    const answers: Record<string, Subject<unknown[]>> = {
      medium: new Subject(),
      high: new Subject(),
    };
    const library = {
      duplicates: vi.fn((accuracy: string) => answers[accuracy] ?? of([])),
      deleteScene: vi.fn(),
    };
    const { fixture } = await render(DuplicatesPageComponent, library);
    const component = fixture.componentInstance as any;

    component.setAccuracy('medium');
    component.setAccuracy('high');
    answers['high'].next([]);
    answers['medium'].next([{ suggestedKeepId: 'm', scenes: [] }]);

    expect(component.accuracy()).toBe('high');
    expect(component.groups()).toEqual([]);
  });
});
