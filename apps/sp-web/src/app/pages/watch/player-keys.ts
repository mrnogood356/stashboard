/** What a key does in the player. */
export type PlayerAction =
  | { type: 'toggle-play' }
  | { type: 'skip'; seconds: number }
  | { type: 'volume'; delta: number }
  | { type: 'seek-percent'; percent: number }
  | { type: 'frame'; direction: -1 | 1 }
  | { type: 'speed'; direction: -1 | 1 }
  | { type: 'chapter'; direction: -1 | 1 }
  | { type: 'next' }
  | { type: 'fullscreen' }
  | { type: 'mute' }
  | { type: 'pip' }
  | { type: 'help' }
  | { type: 'escape' };

export const SKIP_SECONDS = 10;
export const VOLUME_STEP = 0.1;
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
/** One frame at 30 fps, for stepping while paused. */
export const FRAME_SECONDS = 1 / 30;

/** The list "?" shows, in the order it shows them. */
export const PLAYER_SHORTCUTS: ReadonlyArray<{ keys: string[]; does: string }> = [
  { keys: ['Space', 'K'], does: 'Play or pause' },
  { keys: ['←', 'J'], does: 'Back 10 seconds' },
  { keys: ['→', 'L'], does: 'Forward 10 seconds' },
  { keys: ['↑', '↓'], does: 'Volume up or down' },
  { keys: ['M'], does: 'Mute' },
  { keys: ['0–9'], does: 'Jump to 0%–90%' },
  { keys: [',', '.'], does: 'One frame back or forward (while paused)' },
  { keys: ['<', '>'], does: 'Slower or faster' },
  { keys: ['[', ']'], does: 'Previous or next chapter' },
  { keys: ['N'], does: 'Next scene' },
  { keys: ['F'], does: 'Fullscreen' },
  { keys: ['P'], does: 'Picture in picture' },
  { keys: ['?'], does: 'Show these shortcuts' },
  { keys: ['Esc'], does: 'Close, or go back' },
];

/**
 * The player's keyboard shortcuts, the same as most video sites. Keys held
 * with Ctrl, ⌘ or Alt are left to the browser (Ctrl+F still finds).
 */
export function playerKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>,
): PlayerAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }
  const key = event.key;
  if (/^[0-9]$/.test(key)) {
    return { type: 'seek-percent', percent: Number(key) * 10 };
  }
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case ' ':
    case 'k':
      return { type: 'toggle-play' };
    case 'ArrowLeft':
    case 'j':
      return { type: 'skip', seconds: -SKIP_SECONDS };
    case 'ArrowRight':
    case 'l':
      return { type: 'skip', seconds: SKIP_SECONDS };
    case 'ArrowUp':
      return { type: 'volume', delta: VOLUME_STEP };
    case 'ArrowDown':
      return { type: 'volume', delta: -VOLUME_STEP };
    case 'Home':
      return { type: 'seek-percent', percent: 0 };
    case ',':
      return { type: 'frame', direction: -1 };
    case '.':
      return { type: 'frame', direction: 1 };
    case '<':
      return { type: 'speed', direction: -1 };
    case '>':
      return { type: 'speed', direction: 1 };
    case '[':
      return { type: 'chapter', direction: -1 };
    case ']':
      return { type: 'chapter', direction: 1 };
    case 'n':
      return { type: 'next' };
    case 'f':
      return { type: 'fullscreen' };
    case 'm':
      return { type: 'mute' };
    case 'p':
      return { type: 'pip' };
    case '?':
      return { type: 'help' };
    case 'Escape':
      return { type: 'escape' };
    default:
      return null;
  }
}

/** The next speed up or down from `current`, staying within SPEEDS. */
export function stepSpeed(current: number, direction: -1 | 1): number {
  const index = SPEEDS.findIndex((speed) => Math.abs(speed - current) < 0.01);
  const from = index === -1 ? SPEEDS.indexOf(1) : index;
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, from + direction))];
}

/** "1×", "1.5×", "0.25×". */
export function speedLabel(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}
