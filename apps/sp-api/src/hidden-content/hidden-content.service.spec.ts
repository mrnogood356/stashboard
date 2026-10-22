import { PrismaService } from '../prisma/prisma.service';
import { HiddenContentService } from './hidden-content.service';

describe('HiddenContentService', () => {
  let row: Record<string, unknown> | null;
  let findUnique: jest.Mock;
  let upsert: jest.Mock;
  let service: HiddenContentService;

  beforeEach(() => {
    row = null;
    findUnique = jest.fn(() => Promise.resolve(row));
    upsert = jest.fn(
      ({ create }: { create: Record<string, unknown> }) =>
        (row = { ...create }),
    );
    service = new HiddenContentService({
      hiddenContentSettings: { findUnique, upsert },
    } as unknown as PrismaService);
  });

  it('hides nothing until something is saved', async () => {
    await expect(service.getSettings()).resolves.toEqual({
      words: [],
      tags: [],
      studios: [],
      performers: [],
    });
    const rules = await service.getRules();
    expect(rules.matchers).toEqual([]);
    expect(rules.tagIds.size).toBe(0);
    expect(rules.studioIds.size).toBe(0);
  });

  it('saves words split and lowercased, and tags and studios once each', async () => {
    const saved = await service.updateSettings({
      words: ['Trans, transgender', ' -TRANS'],
      tags: [
        { id: 'tag-1', name: ' Trans Woman ' },
        { id: 'tag-1', name: 'Again' },
      ],
      studios: [{ id: 'studio-1', name: '' }],
    });

    expect(saved).toEqual({
      words: ['trans', 'transgender'],
      tags: [{ id: 'tag-1', name: 'Trans Woman' }],
      studios: [{ id: 'studio-1', name: 'studio-1' }],
      performers: [],
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'GLOBAL' } }),
    );
  });

  it('ignores malformed stored entries', async () => {
    row = {
      words: ['trans'],
      tags: [{ id: 'tag-1', name: 'A' }, { name: 'no id' }, null, 'x'],
      studios: 'not a list',
    };

    await expect(service.getSettings()).resolves.toEqual({
      words: ['trans'],
      tags: [{ id: 'tag-1', name: 'A' }],
      studios: [],
      performers: [],
    });
  });

  it('keeps the rules for a while, and reloads them after a save', async () => {
    row = { words: ['trans'], tags: [], studios: [{ id: 's-1', name: 'S' }] };

    const first = await service.getRules();
    await service.getRules();
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(first.matchers[0].test('A Trans scene')).toBe(true);
    expect(first.studioIds.has('s-1')).toBe(true);

    await service.updateSettings({
      words: ['pov'],
      tags: [{ id: 't-1', name: 'T' }],
      studios: [],
    });
    const next = await service.getRules();

    expect(next.matchers[0].test('POV')).toBe(true);
    expect(next.tagIds.has('t-1')).toBe(true);
    expect(next.studioIds.size).toBe(0);
  });

  it('returns no rules when asked to show hidden scenes', async () => {
    row = { words: ['trans'], tags: [], studios: [] };

    const rules = await service.getRules(true);

    expect(rules.matchers).toEqual([]);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('shows everything when the list cannot be read, and tries again next time', async () => {
    findUnique.mockRejectedValueOnce(new Error('database down'));

    const rules = await service.getRules();
    expect(rules.matchers).toEqual([]);

    row = { words: ['trans'], tags: [], studios: [] };
    const retried = await service.getRules();
    expect(retried.matchers).toHaveLength(1);
  });

  it('matches tags and studios by name too, and performers by id only', async () => {
    row = {
      words: [],
      tags: [{ id: 'tag-1', name: 'Trans Woman' }],
      studios: [{ id: 'studio-1', name: 'Some Studio' }],
      performers: [{ id: 'p-1', name: 'Jane Doe' }],
    };

    const rules = await service.getRules();

    expect(rules.tagNames.has('trans woman')).toBe(true);
    expect(rules.studioNames.has('some studio')).toBe(true);
    expect(rules.performerIds.has('p-1')).toBe(true);
  });

  it('keeps saved performers when a save leaves them out', async () => {
    row = {
      words: [],
      tags: [],
      studios: [],
      performers: [{ id: 'p-1', name: 'Jane' }],
    };

    const saved = await service.updateSettings({
      words: ['pov'],
      tags: [],
      studios: [],
    });

    expect(saved.performers).toEqual([{ id: 'p-1', name: 'Jane' }]);
  });

  it('hides and unhides one item at a time', async () => {
    row = { words: ['pov'], tags: [], studios: [], performers: [] };

    const hidden = await service.hideItem('studio', {
      id: 'studio-9',
      name: 'Studio Nine',
    });
    expect(hidden.studios).toEqual([{ id: 'studio-9', name: 'Studio Nine' }]);
    expect(hidden.words).toEqual(['pov']);

    upsert.mockClear();
    const again = await service.hideItem('studio', {
      id: 'studio-9',
      name: 'Studio Nine',
    });
    expect(again.studios).toHaveLength(1);
    expect(upsert).not.toHaveBeenCalled();

    await service.hideItem('performer', { id: 'p-1', name: 'Jane' });
    const rules = await service.getRules();
    expect(rules.studioIds.has('studio-9')).toBe(true);
    expect(rules.performerIds.has('p-1')).toBe(true);

    const unhidden = await service.unhideItem('studio', 'studio-9');
    expect(unhidden.studios).toEqual([]);
    expect(unhidden.performers).toEqual([{ id: 'p-1', name: 'Jane' }]);
    expect((await service.getRules()).studioIds.size).toBe(0);
  });

  it("doesn't lose a tap when two hides arrive together", async () => {
    row = { words: [], tags: [], studios: [], performers: [] };

    await Promise.all([
      service.hideItem('tag', { id: 't-1', name: 'One' }),
      service.hideItem('tag', { id: 't-2', name: 'Two' }),
    ]);

    expect((await service.getSettings()).tags.map((tag) => tag.id)).toEqual([
      't-1',
      't-2',
    ]);
  });
});
