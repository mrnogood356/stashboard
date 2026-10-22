import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LocalLibraryService, SampleScene } from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SamplesPageComponent } from './samples-page.component';

const sample = (id: string, reason: 'name' | 'short' = 'name'): SampleScene => ({
  id,
  title: `Scene ${id}`,
  date: null,
  studio: null,
  playCount: 0,
  organized: false,
  imageUrl: null,
  reason,
  file: {
    path: `/data/Movie.${id}/Sample/sample-${id}.mkv`,
    basename: `sample-${id}.mkv`,
    size: 50 * 1024 * 1024,
    width: 1920,
    height: 1080,
    duration: 30,
    videoCodec: 'h264',
    bitRate: 1,
    frameRate: 30,
  },
});

async function render(library: Record<string, unknown>) {
  await TestBed.configureTestingModule({
    imports: [SamplesPageComponent],
    providers: [
      provideRouter([]),
      { provide: LocalLibraryService, useValue: library },
      { provide: AppNotificationsService, useValue: { success: vi.fn(), error: vi.fn() } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(SamplesPageComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

describe('SamplesPageComponent', () => {
  it('lists samples and removes them all from disk', async () => {
    const library = {
      samples: vi.fn().mockReturnValue(of([sample('1'), sample('2', 'short')])),
      deleteScene: vi.fn().mockReturnValue(of(undefined)),
    };
    const { fixture, root } = await render(library);

    expect(library.samples).toHaveBeenCalledWith(0);
    expect(root.textContent).toContain('2 samples · 100 MB');
    expect(root.textContent).toContain('sample-1.mkv');
    expect(root.textContent).toContain('Very short');

    (root.querySelector('[data-testid="remove-all"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.textContent).toContain('Remove all 2 samples?');
    (root.querySelector('.sheet .btn.danger') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(library.deleteScene).toHaveBeenCalledWith('1', true);
    expect(library.deleteScene).toHaveBeenCalledWith('2', true);
    expect(root.textContent).toContain('No sample files found.');
  });

  it('asks again with a length when one is picked', async () => {
    const library = {
      samples: vi.fn().mockReturnValue(of([])),
      deleteScene: vi.fn(),
    };
    const { fixture, root } = await render(library);

    const tabs = Array.from(root.querySelectorAll('.segmented button')) as HTMLButtonElement[];
    tabs[2].click();
    fixture.detectChanges();

    expect(library.samples).toHaveBeenLastCalledWith(2);
  });
});
