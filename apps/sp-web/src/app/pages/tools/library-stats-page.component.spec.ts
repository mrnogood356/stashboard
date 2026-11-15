import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { LibraryStats, LocalLibraryService } from '../../core/api/local-library.service';
import { LibraryStatsPageComponent } from './library-stats-page.component';

const GB = 1024 ** 3;
const stats: LibraryStats = {
  computedAt: new Date().toISOString(),
  scenes: 3,
  files: 3,
  bytes: 12 * GB,
  duration: 3 * 3600,
  byResolution: [
    { key: '4k', label: '4K', files: 1, bytes: 8 * GB },
    { key: '1080p', label: '1080p', files: 2, bytes: 4 * GB },
  ],
  byCodec: [
    { key: 'hevc', label: 'HEVC (H.265)', files: 1, bytes: 8 * GB },
    { key: 'h264', label: 'H.264', files: 2, bytes: 4 * GB },
  ],
  topStudios: [{ key: 's1', studioId: 's1', label: 'Studio One', files: 3, bytes: 12 * GB }],
  biggest: [
    {
      sceneId: '1',
      title: 'Big one',
      studioName: 'Studio One',
      bytes: 8 * GB,
      resolution: '4K',
      codec: 'HEVC (H.265)',
      duration: 3600,
    },
  ],
  reencode: {
    saving: 2 * GB,
    files: 2,
    top: [
      {
        sceneId: '2',
        title: 'Old encode',
        studioName: null,
        bytes: 3 * GB,
        resolution: '1080p',
        codec: 'H.264',
        duration: 3600,
        saving: 1.4 * GB,
      },
    ],
  },
};

describe('LibraryStatsPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(api: Partial<LocalLibraryService>) {
    await TestBed.configureTestingModule({
      imports: [LibraryStatsPageComponent],
      providers: [provideRouter([]), { provide: LocalLibraryService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryStatsPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows the totals, the breakdowns and what would shrink most', async () => {
    const statsCall = vi.fn().mockReturnValue(of(stats));
    const root = await render({ stats: statsCall });
    const text = root.textContent ?? '';
    expect(root.querySelector('[data-testid="stats-totals"]')?.textContent).toContain('12 GB');
    expect(text).toContain('3 h');
    expect(text).toContain('≈ 2.0 GB');
    expect(text).toContain('HEVC (H.265)');
    expect(text).toContain('Studio One');
    expect(text).toContain('Old encode');
    expect(text).toContain('Big one');
    expect(root.querySelector('[data-testid="reencode-link"]')?.getAttribute('href')).toBe(
      '/tools/better-copies',
    );
    // The biggest bucket fills the bar; the next one is in proportion.
    const bars = [...root.querySelectorAll<HTMLElement>('.bar')].map((bar) => bar.style.width);
    expect(bars.slice(0, 2)).toEqual(['100%', '50%']);

    (root.querySelector('[data-testid="stats-refresh"]') as HTMLButtonElement).click();
    expect(statsCall).toHaveBeenLastCalledWith(true);
  });

  it('says so when Refresh fails, keeping the numbers from before', async () => {
    const statsCall = vi
      .fn()
      .mockReturnValueOnce(of(stats))
      .mockReturnValueOnce(throwError(() => new Error('down')));
    await TestBed.configureTestingModule({
      imports: [LibraryStatsPageComponent],
      providers: [
        provideRouter([]),
        { provide: LocalLibraryService, useValue: { stats: statsCall } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryStatsPageComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="stats-refresh-error"]')).toBeNull();

    (root.querySelector('[data-testid="stats-refresh"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="stats-refresh-error"]')).not.toBeNull();
    expect(root.textContent).toContain('Studio One');
  });

  it('says so when Stash can’t be read', async () => {
    const root = await render({
      stats: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
    });
    expect(root.textContent).toContain('Couldn’t read your library from Stash');
  });
});
