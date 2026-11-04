import type { StashdbMatchScene } from '../providers/stashdb/stashdb.adapter';
import {
  dropBracketed,
  parseFileName,
  scoreByName,
} from './match-scoring.util';

function scene(overrides: Partial<StashdbMatchScene> = {}): StashdbMatchScene {
  return {
    id: 'x',
    title: 'Poolside Afternoon',
    code: null,
    details: null,
    director: null,
    date: '2024-05-02',
    duration: 1800,
    imageUrl: null,
    studio: { id: 's', name: 'Brazzers' },
    performers: [
      {
        id: 'p',
        name: 'Jane Doe',
        as: null,
        disambiguation: null,
        gender: 'FEMALE',
      },
    ],
    tags: [],
    urls: [],
    ...overrides,
  };
}

describe('scoreByName', () => {
  it('is never sure from length, studio and performer alone', () => {
    // A performer's other scene at the same studio, about as long.
    const parsed = parseFileName(
      'Brazzers - Jane Doe & Ann Lee - Kitchen Fun.mp4',
    );
    const result = scoreByName(
      parsed,
      1801,
      scene({
        performers: ['Jane Doe', 'Ann Lee'].map((name, index) => ({
          id: `p${index}`,
          name,
          as: null,
          disambiguation: null,
          gender: 'FEMALE',
        })),
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.confidence).toBe('likely');
  });

  it('calls length and studio alone weak', () => {
    const parsed = parseFileName('Brazzers.Something.Else.1080p.mp4');
    expect(scoreByName(parsed, 1800, scene()).confidence).toBe('weak');
  });

  it('is sure when the title agrees as well', () => {
    const parsed = parseFileName(
      'Brazzers - Jane Doe - Poolside Afternoon.mp4',
    );
    expect(scoreByName(parsed, 1800, scene()).confidence).toBe('strong');
  });

  it('is sure when the date agrees as well', () => {
    const parsed = parseFileName('Brazzers.24.05.02.Jane.Doe.XXX.1080p.mp4');
    expect(scoreByName(parsed, 1800, scene()).confidence).toBe('strong');
  });
});

describe('dropBracketed', () => {
  it('replaces each [...] and {...} group with a space', () => {
    expect(dropBracketed('Title [1080p] {web}-GRP')).toBe('Title    -GRP');
    expect(dropBracketed('[a[b]c]')).toBe(' c]');
    expect(dropBracketed('no groups')).toBe('no groups');
  });

  it('keeps a bracket that is never closed', () => {
    expect(dropBracketed('Title [unclosed {x} end')).toBe(
      'Title [unclosed   end',
    );
  });

  it('matches the regex it replaced', () => {
    const old = (text: string) => text.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
    const alphabet = ['[', ']', '{', '}', 'a', ' ', '-'];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 2000; round += 1) {
      const length = next() % 16;
      let text = '';
      for (let i = 0; i < length; i += 1) {
        text += alphabet[next() % alphabet.length];
      }
      expect(dropBracketed(text)).toBe(old(text));
    }
  });

  it('stays fast on a long run of unclosed brackets', () => {
    const tricky = '['.repeat(200_000);
    const started = Date.now();
    expect(dropBracketed(tricky)).toBe(tricky);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
