import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  DuplicateGroup,
  DuplicateScene,
  LocalLibraryService,
} from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { DuplicatesPageComponent } from './duplicates-page.component';

function scene(id: string, height: number, size = 2 * 1024 * 1024 * 1024): DuplicateScene {
  return {
    id,
    title: `Scene ${id}`,
    date: null,
    studio: null,
    playCount: 0,
    organized: false,
    imageUrl: null,
    file: {
      path: `/data/${id}.mp4`,
      basename: `${id}.mp4`,
      size,
      width: Math.round((height * 16) / 9),
      height,
      duration: 125,
      videoCodec: 'hevc',
      bitRate: 8_000_000,
      frameRate: 30,
    },
  };
}

async function render(library: Record<string, unknown>) {
  const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [DuplicatesPageComponent],
    providers: [
      provideRouter([]),
      { provide: LocalLibraryService, useValue: library },
      { provide: AppNotificationsService, useValue: notifications },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(DuplicatesPageComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, notifications };
}

/** The delete runs one copy at a time; let it finish. */
async function settle(fixture: { detectChanges(): void }): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
  fixture.detectChanges();
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((entry) =>
    entry.textContent?.includes(text),
  )!;
}

describe('DuplicatesPageComponent', () => {
  it('asks for exact matches first and shows each copy with its details', async () => {
    const groups: DuplicateGroup[] = [
      { suggestedKeepId: 'a', scenes: [scene('a', 2160), scene('b', 720, 300 * 1024 * 1024)] },
    ];
    const library = { duplicates: vi.fn().mockReturnValue(of(groups)), deleteScene: vi.fn() };
    const { root } = await render(library);

    expect(library.duplicates).toHaveBeenCalledWith('exact');
    expect(root.textContent).toContain('1 set of copies');
    const [best, other] = Array.from(root.querySelectorAll('.copy'));
    expect(best.classList).toContain('best');
    expect(best.textContent).toContain('Best copy');
    expect(best.textContent).toContain('Keep this one');
    expect(best.textContent).toContain('4K');
    expect(best.textContent).toContain('2.0 GB');
    expect(best.textContent).toContain('8.0 Mbps');
    expect(best.textContent).toContain('2:05');
    expect(best.textContent).toContain('HEVC');
    expect(best.querySelector('button')).toBeNull();
    expect(other.textContent).toContain('720p');
    expect(other.textContent).toContain('300 MB');
    expect(other.textContent).toContain('Remove this copy');
  });

  it('asks again when another accuracy is picked', async () => {
    const library = { duplicates: vi.fn().mockReturnValue(of([])), deleteScene: vi.fn() };
    const { fixture, root } = await render(library);

    expect(root.textContent).toContain('No duplicates found.');
    button(root, 'Very close').click();
    fixture.detectChanges();
    expect(library.duplicates).toHaveBeenLastCalledWith('high');
    expect(button(root, 'Very close').getAttribute('aria-selected')).toBe('true');

    // Picking the same one again doesn't ask twice.
    button(root, 'Very close').click();
    expect(library.duplicates).toHaveBeenCalledTimes(2);
  });

  it('shows an error when Stash cannot be asked', async () => {
    const library = {
      duplicates: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
      deleteScene: vi.fn(),
    };
    const { root } = await render(library);

    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't ask Stash for duplicates",
    );
    expect(root.textContent).not.toContain('No duplicates found.');
  });

  it('can remove a copy from Stash only and keeps the set while two copies are left', async () => {
    const groups: DuplicateGroup[] = [
      { suggestedKeepId: 'a', scenes: [scene('a', 1080), scene('b', 720), scene('c', 480)] },
    ];
    const library = {
      duplicates: vi.fn().mockReturnValue(of(groups)),
      deleteScene: vi.fn().mockReturnValue(of(undefined)),
    };
    const { fixture, root, notifications } = await render(library);

    root.querySelectorAll<HTMLButtonElement>('.copy .btn.danger')[1].click();
    fixture.detectChanges();
    expect(root.querySelector('.sheet')?.textContent).toContain('c.mp4');
    button(root, 'Remove from Stash only').click();
    await settle(fixture);

    expect(library.deleteScene).toHaveBeenCalledWith('c', false, false);
    expect(notifications.success).toHaveBeenCalledWith(
      'Removed from Stash',
      'The file was left on disk.',
    );
    expect(root.querySelector('.sheet')).toBeNull();
    expect(Array.from(root.querySelectorAll('.copy-title')).map((el) => el.textContent)).toEqual([
      'Scene a',
      'Scene b',
    ]);
  });

  it('cancel closes the sheet without removing anything', async () => {
    const groups: DuplicateGroup[] = [
      { suggestedKeepId: 'a', scenes: [scene('a', 1080), scene('b', 720)] },
    ];
    const library = { duplicates: vi.fn().mockReturnValue(of(groups)), deleteScene: vi.fn() };
    const { fixture, root } = await render(library);

    root.querySelector<HTMLButtonElement>('.copy .btn.danger')!.click();
    fixture.detectChanges();
    button(root, 'Cancel').click();
    fixture.detectChanges();

    expect(root.querySelector('.sheet')).toBeNull();
    expect(library.deleteScene).not.toHaveBeenCalled();
    expect(root.querySelectorAll('.copy').length).toBe(2);
  });

  it('keeps the copy and says so when the delete fails', async () => {
    const groups: DuplicateGroup[] = [
      { suggestedKeepId: 'a', scenes: [scene('a', 1080), scene('b', 720)] },
    ];
    const library = {
      duplicates: vi.fn().mockReturnValue(of(groups)),
      deleteScene: vi.fn().mockReturnValue(throwError(() => new Error('nope'))),
    };
    const { fixture, root, notifications } = await render(library);

    root.querySelector<HTMLButtonElement>('.copy .btn.danger')!.click();
    fixture.detectChanges();
    button(root, 'Delete the file from disk').click();
    await settle(fixture);

    expect(library.deleteScene).toHaveBeenCalledWith('b', true, true);
    expect(notifications.error).toHaveBeenCalledWith(
      "Couldn't delete that scene",
      expect.any(String),
    );
    expect(notifications.success).not.toHaveBeenCalled();
    expect(root.querySelectorAll('.copy').length).toBe(2);
    // The sheet stays open and usable so the user can try again.
    expect(button(root, 'Delete the file from disk').disabled).toBe(false);
  });

  it('asks again when a list asked for before a delete answers after it', async () => {
    const groups: DuplicateGroup[] = [
      { suggestedKeepId: 'a', scenes: [scene('a', 1080), scene('b', 720), scene('c', 480)] },
    ];
    const late = new Subject<DuplicateGroup[]>();
    const deleted = new Subject<void>();
    const library = {
      duplicates: vi
        .fn()
        .mockReturnValueOnce(of(groups))
        .mockReturnValueOnce(late)
        .mockReturnValue(of([{ ...groups[0], scenes: groups[0].scenes.slice(0, 2) }])),
      deleteScene: vi.fn().mockReturnValue(deleted),
    };
    const { fixture, root } = await render(library);

    root.querySelectorAll<HTMLButtonElement>('.copy .btn.danger')[1].click();
    fixture.detectChanges();
    button(root, 'Remove from Stash only').click();
    // Another accuracy picked while the delete is on its way.
    (fixture.componentInstance as any).setAccuracy('high');
    late.next(groups);
    deleted.next();
    deleted.complete();
    await settle(fixture);

    expect(library.duplicates).toHaveBeenCalledTimes(3);
    expect(Array.from(root.querySelectorAll('.copy-title')).map((el) => el.textContent)).toEqual([
      'Scene a',
      'Scene b',
    ]);
  });

  it('removes every copy but the best in a set, or in every set, one at a time', async () => {
    const groups: DuplicateGroup[] = [
      {
        suggestedKeepId: 'a',
        keepReason: 'Highest resolution.',
        scenes: [scene('a', 1080), scene('b', 720), scene('c', 480)],
      },
      { suggestedKeepId: 'd', scenes: [scene('d', 1080), scene('e', 720)] },
    ];
    const library = {
      duplicates: vi.fn().mockReturnValue(of(groups)),
      deleteScene: vi.fn().mockReturnValue(of(undefined)),
    };
    const { fixture, root, notifications } = await render(library);
    expect(root.textContent).toContain('Highest resolution.');

    root.querySelector<HTMLButtonElement>('[data-testid="remove-all-extras"]')!.click();
    fixture.detectChanges();
    expect(root.querySelector('.sheet h2')?.textContent).toContain('Remove 3 copies?');
    button(root, 'Remove from Stash only').click();
    await settle(fixture);

    expect(library.deleteScene.mock.calls.map((call) => call[0])).toEqual(['b', 'c', 'e']);
    expect(notifications.success).toHaveBeenCalledWith(
      'Removed from Stash',
      '3 copies removed, files left on disk.',
    );
    expect(root.querySelectorAll('.copy').length).toBe(0);
  });

  it('stops at the first copy that fails and keeps the rest to try again', async () => {
    const groups: DuplicateGroup[] = [
      { suggestedKeepId: 'a', scenes: [scene('a', 1080), scene('b', 720), scene('c', 480)] },
    ];
    const library = {
      duplicates: vi.fn().mockReturnValue(of(groups)),
      deleteScene: vi
        .fn()
        .mockReturnValueOnce(of(undefined))
        .mockReturnValueOnce(throwError(() => new Error('nope'))),
    };
    const { fixture, root } = await render(library);

    root.querySelector<HTMLButtonElement>('[data-testid="remove-extras"]')!.click();
    fixture.detectChanges();
    button(root, 'Delete the files from disk').click();
    await settle(fixture);

    expect(root.querySelector('.sheet h2')?.textContent).toContain('Remove this copy?');
    expect(root.querySelector('.sheet')?.textContent).toContain('c.mp4');
  });

  it('never deletes from disk a scene with more than one file', async () => {
    const multi = { ...scene('c', 480), fileCount: 2 };
    const groups: DuplicateGroup[] = [
      { suggestedKeepId: 'a', scenes: [scene('a', 1080), scene('b', 720), multi] },
    ];
    const library = {
      duplicates: vi.fn().mockReturnValue(of(groups)),
      deleteScene: vi.fn().mockReturnValue(of(undefined)),
    };
    const { fixture, root, notifications } = await render(library);

    // Only that one: deleting from disk isn't offered.
    root.querySelectorAll<HTMLButtonElement>('.copy .btn.danger')[1].click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="multi-file-note"]')).toBeTruthy();
    expect(button(root, 'Delete the file from disk').disabled).toBe(true);
    button(root, 'Cancel').click();
    fixture.detectChanges();

    // With others: they're deleted, it's left in place, and the server is asked to refuse too.
    root.querySelector<HTMLButtonElement>('[data-testid="remove-extras"]')!.click();
    fixture.detectChanges();
    button(root, 'Delete the files from disk').click();
    await settle(fixture);
    expect(library.deleteScene.mock.calls).toEqual([['b', true, true]]);
    expect(notifications.info).toHaveBeenCalledWith('1 left in place', expect.any(String));
  });
});
