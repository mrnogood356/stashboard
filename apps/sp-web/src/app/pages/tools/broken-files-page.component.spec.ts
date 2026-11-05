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
      { provide: AppNotificationsService, useValue: { success: vi.fn(), error: vi.fn() } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(BrokenFilesPageComponent);
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

describe('BrokenFilesPageComponent', () => {
  it('lists only kinds with problems, each with its fix', async () => {
    const startJob = vi.fn().mockReturnValue(of({ jobId: '1' }));
    const generateFor = vi.fn().mockReturnValue(of({ jobId: '2' }));
    const { fixture, root } = await render(
      [
        { kind: 'no-file', count: 2, scenes: scenes(2) },
        { kind: 'no-length', count: 0, scenes: [] },
        { kind: 'no-cover', count: 3, scenes: scenes(3) },
        { kind: 'no-fingerprint', count: 120, scenes: scenes(50) },
      ],
      { startJob, generateFor },
    );

    expect(root.querySelector('[data-testid="problem-no-length"]')).toBeNull();
    expect(root.textContent).toContain('And 70 more.');

    // No one-tap fix for scenes with no file: Clean wouldn't remove them.
    expect(root.querySelector('[data-testid="fix-no-file"]')).toBeNull();
    // A few scenes: Generate for just them. Many: for the library.
    root.querySelector<HTMLButtonElement>('[data-testid="fix-no-cover"]')!.click();
    expect(generateFor).toHaveBeenCalledWith(['1', '2', '3']);
    root.querySelector<HTMLButtonElement>('[data-testid="fix-no-fingerprint"]')!.click();
    expect(startJob).toHaveBeenCalledWith('generate');

    fixture.detectChanges();
    expect(
      root.querySelector<HTMLButtonElement>('[data-testid="fix-no-cover"]')!.textContent,
    ).toContain('Started');
    expect(startJob).not.toHaveBeenCalledWith('clean');

    // Look again: anything still listed can be fixed again.
    root.querySelector<HTMLButtonElement>('.head-action')!.click();
    fixture.detectChanges();
    expect(root.querySelector<HTMLButtonElement>('[data-testid="fix-no-cover"]')!.disabled).toBe(
      false,
    );
  });

  it('says so when nothing is broken', async () => {
    const { root } = await render([
      { kind: 'no-file', count: 0, scenes: [] },
      { kind: 'no-length', count: 0, scenes: [] },
      { kind: 'no-cover', count: 0, scenes: [] },
      { kind: 'no-fingerprint', count: 0, scenes: [] },
    ]);
    expect(root.textContent).toContain('Nothing broken');
  });
});
