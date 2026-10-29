import { playerKeyAction, speedLabel, stepSpeed } from './player-keys';

const key = (value: string, mods: Partial<KeyboardEvent> = {}) =>
  playerKeyAction({ key: value, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('player keys', () => {
  it('uses the keys most video sites use', () => {
    expect(key(' ')).toEqual({ type: 'toggle-play' });
    expect(key('K')).toEqual({ type: 'toggle-play' });
    expect(key('j')).toEqual({ type: 'skip', seconds: -10 });
    expect(key('ArrowRight')).toEqual({ type: 'skip', seconds: 10 });
    expect(key('ArrowUp')).toEqual({ type: 'volume', delta: 0.1 });
    expect(key('7')).toEqual({ type: 'seek-percent', percent: 70 });
    expect(key('Home')).toEqual({ type: 'seek-percent', percent: 0 });
    expect(key('.')).toEqual({ type: 'frame', direction: 1 });
    expect(key('>')).toEqual({ type: 'speed', direction: 1 });
    expect(key('[')).toEqual({ type: 'chapter', direction: -1 });
    expect(key('N')).toEqual({ type: 'next' });
    expect(key('?')).toEqual({ type: 'help' });
  });

  it('leaves keys with Ctrl, ⌘ or Alt to the browser', () => {
    expect(key('f', { ctrlKey: true })).toBeNull();
    expect(key('k', { metaKey: true })).toBeNull();
    expect(key('ArrowLeft', { altKey: true })).toBeNull();
    expect(key('x')).toBeNull();
  });

  it('steps through the speeds and stops at the ends', () => {
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1, -1)).toBe(0.75);
    expect(stepSpeed(2, 1)).toBe(2);
    expect(stepSpeed(0.25, -1)).toBe(0.25);
    expect(stepSpeed(1.1, 1)).toBe(1.25);
    expect(speedLabel(1.5)).toBe('1.5×');
    expect(speedLabel(1)).toBe('1×');
  });
});
