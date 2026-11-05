import { HomeRailKey, type HomeRail } from '@prisma/client';
import { FRESH_MS, HomeRowCache, STALE_MS } from './home-row-cache';

const rail = (over: Partial<HomeRail> = {}): HomeRail =>
  ({
    id: 'r1',
    key: null,
    source: 'STASHDB',
    config: { sort: 'DATE' },
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    ...over,
  }) as unknown as HomeRail;

const content = (title: string, message: string | null = null) => ({
  items: [{ title } as never],
  message,
});

describe('HomeRowCache', () => {
  let now = 0;
  const cache = () => new HomeRowCache(() => now);
  beforeEach(() => (now = 1_000_000));

  it('answers a fresh row from memory, and a stale one at once while it builds again', async () => {
    const rows = cache();
    const load = jest
      .fn()
      .mockResolvedValueOnce(content('first'))
      .mockResolvedValueOnce(content('second'));

    expect((await rows.get(rail(), load)).items[0]).toEqual({ title: 'first' });
    now += FRESH_MS - 1;
    await rows.get(rail(), load);
    expect(load).toHaveBeenCalledTimes(1);

    now += 2;
    // Stale: the kept answer comes straight back, and a new one is built behind it.
    expect((await rows.get(rail(), load)).items[0]).toEqual({ title: 'first' });
    expect(load).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect((await rows.get(rail(), load)).items[0]).toEqual({
      title: 'second',
    });
  });

  it('builds again when the row changed, it is too old, or what it hides changed', async () => {
    const rows = cache();
    const load = jest.fn().mockResolvedValue(content('x'));
    await rows.get(rail(), load);
    await rows.get(rail({ updatedAt: new Date('2026-11-02T00:00:00Z') }), load);
    expect(load).toHaveBeenCalledTimes(2);

    await rows.get(
      rail({ updatedAt: new Date('2026-11-02T00:00:00Z') }),
      load,
      undefined,
      'h2',
    );
    expect(load).toHaveBeenCalledTimes(3);

    now += STALE_MS;
    await rows.get(
      rail({ updatedAt: new Date('2026-11-02T00:00:00Z') }),
      load,
      undefined,
      'h2',
    );
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('never keeps Continue Watching, or a row that came back with a message', async () => {
    const rows = cache();
    const load = jest.fn().mockResolvedValue(content('x'));
    await rows.get(rail({ key: HomeRailKey.CONTINUE_WATCHING }), load);
    await rows.get(rail({ key: HomeRailKey.CONTINUE_WATCHING }), load);
    expect(load).toHaveBeenCalledTimes(2);

    const failing = jest
      .fn()
      .mockResolvedValue(content('x', 'Stash is not set up.'));
    await rows.get(rail({ id: 'r2' }), failing);
    await rows.get(rail({ id: 'r2' }), failing);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('brings a kept row up to date before sending it, and sends it as kept if that fails', async () => {
    const rows = cache();
    await rows.get(rail(), jest.fn().mockResolvedValue(content('kept')));
    const updated = await rows.get(rail(), jest.fn(), async () =>
      content('updated'),
    );
    expect(updated.items[0]).toEqual({ title: 'updated' });
    const asKept = await rows.get(rail(), jest.fn(), () =>
      Promise.reject(new Error('db')),
    );
    expect(asKept.items[0]).toEqual({ title: 'kept' });
  });

  it('shares one build between callers asking at the same time', async () => {
    const rows = cache();
    let finish!: (value: ReturnType<typeof content>) => void;
    const load = jest.fn(
      () => new Promise<ReturnType<typeof content>>((r) => (finish = r)),
    );
    const a = rows.get(rail(), load);
    const b = rows.get(rail(), load);
    finish(content('once'));
    expect((await a).items).toEqual((await b).items);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
