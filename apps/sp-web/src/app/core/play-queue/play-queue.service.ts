import { Injectable, signal } from '@angular/core';

/** One thing to play: a scene, or part of one (a chapter). */
export interface QueueItem {
  sceneId: string;
  title: string;
  imageUrl: string | null;
  /** Where to start, in seconds; the resume point when missing. */
  start?: number;
  /** Where to stop and go on to the next; the end when missing. */
  end?: number;
}

export interface PlayQueue {
  /** What the queue is, e.g. "Watch later" or "Chapters: Beach". */
  label: string;
  /** "later": each scene leaves Watch later once played to its end. */
  kind: 'later' | 'chapters' | 'other';
  items: QueueItem[];
  index: number;
}

const KEY = 'stashboard.playQueue';

/**
 * What plays next when you play a list: Watch later or a chapter playlist.
 * Kept in this tab's session, so a reload keeps it and a new tab starts fresh.
 */
@Injectable({ providedIn: 'root' })
export class PlayQueueService {
  readonly queue = signal<PlayQueue | null>(read());

  start(queue: Omit<PlayQueue, 'index'>, index = 0): QueueItem | null {
    if (queue.items.length === 0) {
      this.clear();
      return null;
    }
    const next: PlayQueue = {
      ...queue,
      index: Math.min(Math.max(0, index), queue.items.length - 1),
    };
    this.set(next);
    return next.items[next.index];
  }

  /** The item playing, when it's this scene. */
  currentFor(sceneId: string): QueueItem | null {
    const queue = this.queue();
    const item = queue?.items[queue.index];
    return item && item.sceneId === sceneId ? item : null;
  }

  peekNext(): QueueItem | null {
    const queue = this.queue();
    return queue ? (queue.items[queue.index + 1] ?? null) : null;
  }

  /** Moves on, giving the next item; the queue ends after the last one. */
  advance(): QueueItem | null {
    const queue = this.queue();
    if (!queue) {
      return null;
    }
    const index = queue.index + 1;
    if (index >= queue.items.length) {
      this.clear();
      return null;
    }
    this.set({ ...queue, index });
    return queue.items[index];
  }

  /** Where it is in the queue, e.g. "3 of 12". */
  position(): string | null {
    const queue = this.queue();
    return queue ? `${queue.index + 1} of ${queue.items.length}` : null;
  }

  clear(): void {
    this.queue.set(null);
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // Storage blocked: it lives only in memory.
    }
  }

  private set(queue: PlayQueue): void {
    this.queue.set(queue);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(queue));
    } catch {
      // Storage blocked: it lives only in memory.
    }
  }
}

/** Shuffles a copy (Fisher–Yates). */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function read(): PlayQueue | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as PlayQueue;
    return Array.isArray(value?.items) && typeof value.index === 'number' ? value : null;
  } catch {
    return null;
  }
}
