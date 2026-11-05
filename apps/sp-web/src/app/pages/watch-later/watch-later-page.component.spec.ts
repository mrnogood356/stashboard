import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { LocalSceneCard } from '../../core/api/local-library.service';
import { WatchLaterService } from '../../core/api/watch-later.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { PlayQueueService } from '../../core/play-queue/play-queue.service';
import { WatchLaterPageComponent } from './watch-later-page.component';

const card = (id: string): LocalSceneCard => ({
  id,
  title: `Scene ${id}`,
  imageUrl: null,
  cardImageUrl: `/img/${id}`,
  studioId: null,
  studio: 'Studio',
  studioImageUrl: null,
  releaseDate: null,
  duration: 1500,
  playCount: 0,
  progress: null,
  type: 'SCENE',
  source: 'STASH',
});

async function render() {
  sessionStorage.removeItem('stashboard.playQueue');
  const api = {
    list: vi.fn(() => of({ items: [card('1'), card('2'), card('3')] })),
    reorder: vi.fn(() => of([])),
    remove: vi.fn(() => of([])),
    clear: vi.fn(() => of([])),
  };
  await TestBed.configureTestingModule({
    imports: [WatchLaterPageComponent],
    providers: [
      provideRouter([]),
      { provide: WatchLaterService, useValue: api },
      { provide: AppNotificationsService, useValue: { success: vi.fn(), error: vi.fn() } },
    ],
  }).compileComponents();
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(WatchLaterPageComponent);
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, api, navigate };
}

describe('WatchLaterPageComponent', () => {
  it('plays from a scene, queueing the rest after it', async () => {
    const { root, navigate } = await render();
    (root.querySelector('[aria-label="Play from Scene 2"]') as HTMLButtonElement).click();
    expect(navigate).toHaveBeenCalledWith(['/watch', '2'], {
      queryParams: { returnTo: '/watch-later' },
    });
    const queue = TestBed.inject(PlayQueueService).queue()!;
    expect(queue.kind).toBe('later');
    expect(queue.items.map((item) => item.sceneId)).toEqual(['2', '3']);
  });

  it('moves, removes and clears (with a second tap)', async () => {
    const { fixture, root, api } = await render();
    (root.querySelector('[aria-label="Move Scene 3 up"]') as HTMLButtonElement).click();
    expect(api.reorder).toHaveBeenCalledWith(['1', '3', '2']);
    (root.querySelector('[aria-label="Remove Scene 1"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(api.remove).toHaveBeenCalledWith('1');
    expect(root.querySelectorAll('.row').length).toBe(2);

    const clear = root.querySelector('.clear') as HTMLButtonElement;
    clear.click();
    fixture.detectChanges();
    expect(api.clear).not.toHaveBeenCalled();
    clear.click();
    fixture.detectChanges();
    expect(api.clear).toHaveBeenCalled();
    expect(root.textContent).toContain('Nothing saved yet');
  });
});
