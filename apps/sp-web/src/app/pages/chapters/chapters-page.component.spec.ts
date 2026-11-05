import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LocalLibraryService, type Chapter } from '../../core/api/local-library.service';
import { PlayQueueService } from '../../core/play-queue/play-queue.service';
import { ChaptersPageComponent } from './chapters-page.component';

const chapter = (id: string, sceneId: string, seconds: number, endSeconds: number): Chapter => ({
  id,
  title: `Chapter ${id}`,
  seconds,
  endSeconds,
  tagName: 'Pool',
  sceneId,
  sceneTitle: `Scene ${sceneId}`,
  imageUrl: `/m/${id}`,
  previewUrl: `/p/${id}`,
});

async function render(query: Record<string, string> = {}) {
  sessionStorage.removeItem('stashboard.playQueue');
  const library = {
    chapters: vi.fn(() => of([chapter('1', '5', 10, 40), chapter('2', '6', 100, 160)])),
    chapterTags: vi.fn(() => of([{ id: '9', name: 'Pool', count: 2 }])),
  };
  await TestBed.configureTestingModule({
    imports: [ChaptersPageComponent],
    providers: [
      provideRouter([]),
      { provide: LocalLibraryService, useValue: library },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(query) } },
      },
    ],
  }).compileComponents();
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(ChaptersPageComponent);
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, library, navigate };
}

describe('ChaptersPageComponent', () => {
  it('lists chapters, filters by a tag, and plays from one as a chapter list', async () => {
    const { fixture, root, library, navigate } = await render();
    expect(root.querySelectorAll('.chapter').length).toBe(2);
    expect(root.textContent).toContain('0:30');

    (root.querySelector('.chips .chip') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(library.chapters).toHaveBeenLastCalledWith({
      tag: '9',
      performer: undefined,
      q: undefined,
    });

    (root.querySelector('[data-testid="chapter-2"]') as HTMLButtonElement).click();
    expect(navigate).toHaveBeenCalledWith(['/watch', '6'], expect.anything());
    const queue = TestBed.inject(PlayQueueService).queue()!;
    expect(queue).toMatchObject({ kind: 'chapters', label: 'Chapters: Pool' });
    expect(queue.items).toEqual([
      { sceneId: '6', title: 'Chapter 2 · Scene 6', imageUrl: '/m/2', start: 100, end: 160 },
    ]);
  });

  it('shows just a performer’s chapters when opened from their page', async () => {
    const { root, library } = await render({ performer: '33', name: 'Jane' });
    expect(library.chapters).toHaveBeenCalledWith({
      tag: undefined,
      performer: '33',
      q: undefined,
    });
    expect(root.textContent).toContain('Jane');
  });
});
