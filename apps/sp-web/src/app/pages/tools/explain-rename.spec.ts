import { describe, expect, it } from 'vitest';
import { explainRename } from './organize-page.component';

const plan = (from: string, to: string) => ({
  sceneId: '1',
  fileId: 'f1',
  title: 'Scene',
  from,
  to,
  state: 'ready' as const,
});

describe('explainRename', () => {
  it('says the file goes into its own folder and what its name gains', () => {
    const why = explainRename(
      plan(
        '/data/stash content/scenes/BaeBaeZoe/2024-09-02 - Asshole Stretch + Doggy Anal + Cumshot On Ass.mp4',
        '/data/stash content/scenes/BaeBaeZoe/2024-09-02 - Asshole Stretch + Doggy Anal + Cumshot On Ass/BaeBaeZoe.Asshole.Stretch.+.Doggy.Anal.+.Cumshot.On.Ass.2024-09-02.WEBDL-2160p.mp4',
      ),
    );
    expect(why.reasons).toEqual([
      'Goes into its own folder: 2024-09-02 - Asshole Stretch + Doggy Anal + Cumshot On Ass',
      'Adds BaeBaeZoe, WEBDL, 2160p',
    ]);
    expect(why.name.filter((piece) => piece.added).map((piece) => piece.text)).toEqual([
      'BaeBaeZoe',
      'WEBDL',
      '2160p',
    ]);
  });

  it('notices names that only change separators or letter case', () => {
    expect(
      explainRename(plan('/data/S/Summer Afternoon.mp4', '/data/S/Summer.Afternoon.mp4')).reasons,
    ).toEqual(['Same words, spaces become dots']);
    expect(
      explainRename(plan('/data/S/summer afternoon.mp4', '/data/S/Summer Afternoon.mp4')).reasons,
    ).toEqual(['Only the letter case changes']);
  });

  it('says what a name drops and where a file moves', () => {
    expect(
      explainRename(
        plan('/data/inbox/Summer.Afternoon.XXX.mp4', '/data/Bright/Summer.Afternoon.mp4'),
      ).reasons,
    ).toEqual(['Moves from …/inbox to …/Bright', 'Drops XXX']);
  });
});
