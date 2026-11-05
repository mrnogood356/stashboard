import { describe, expect, it } from 'vitest';
import { PlayQueueService, shuffled } from './play-queue.service';

describe('PlayQueueService', () => {
  it('steps through the list, keeps it for a reload, and ends after the last', () => {
    sessionStorage.removeItem('stashboard.playQueue');
    const queue = new PlayQueueService();
    queue.start({
      label: 'Watch later',
      kind: 'later',
      items: [
        { sceneId: '1', title: 'One', imageUrl: null },
        { sceneId: '2', title: 'Two', imageUrl: null },
      ],
    });
    expect(queue.currentFor('1')?.title).toBe('One');
    expect(queue.currentFor('2')).toBeNull();
    expect(queue.position()).toBe('1 of 2');
    expect(queue.advance()?.sceneId).toBe('2');
    expect(new PlayQueueService().currentFor('2')?.title).toBe('Two');
    expect(queue.advance()).toBeNull();
    expect(queue.queue()).toBeNull();
    expect(sessionStorage.getItem('stashboard.playQueue')).toBeNull();
  });

  it('shuffles a copy, keeping every item', () => {
    const items = [1, 2, 3, 4, 5];
    const result = shuffled(items, () => 0);
    expect(result).not.toBe(items);
    expect([...result].sort()).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });
});
