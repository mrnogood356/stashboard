import { PendingScenesService, siteOf } from './pending-scenes.service';

describe('PendingScenesService', () => {
  function setup() {
    const getPendingScenes = jest.fn().mockResolvedValue({
      total: 1,
      scenes: [
        {
          editId: 'e1',
          title: null,
          date: '2026-12-01',
          duration: 1500,
          studio: { id: 's1', name: 'Gold Studio' },
          performers: [{ id: 'p1', name: 'Nova' }],
          imageUrl: 'https://cdn.stashdb.org/images/ab/cd/abcd',
          votes: 2,
          submittedAt: '2026-11-20T10:00:00Z',
        },
      ],
    });
    const service = new PendingScenesService(
      {
        getConfiguredCatalogProvider: jest.fn().mockResolvedValue({
          baseUrl: 'https://stashdb.org/graphql',
          apiKey: 'key',
        }),
      } as never,
      { getPendingScenes } as never,
    );
    return { service, getPendingScenes };
  }

  it('lists a studio’s pending new scenes with a link to each edit', async () => {
    const { service, getPendingScenes } = setup();

    const result = await service.forStudio(' s1 ');

    expect(getPendingScenes).toHaveBeenCalledWith(
      { baseUrl: 'https://stashdb.org/graphql', apiKey: 'key' },
      { kind: 'STUDIO', id: 's1' },
      25,
    );
    expect(result.total).toBe(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        editId: 'e1',
        title: 'Untitled scene',
        studioName: 'Gold Studio',
        performers: ['Nova'],
        votes: 2,
        url: 'https://stashdb.org/edits/e1',
      }),
    );
  });

  it('asks the catalog once for a while, and again after a failure', async () => {
    const { service, getPendingScenes } = setup();
    await service.forPerformer('p1');
    await service.forPerformer('p1');
    expect(getPendingScenes).toHaveBeenCalledTimes(1);

    getPendingScenes.mockRejectedValueOnce(new Error('down'));
    await expect(service.forStudio('s2')).rejects.toThrow('down');
    await service.forStudio('s2');
    expect(getPendingScenes).toHaveBeenCalledTimes(3);
  });

  it('refuses an empty id', async () => {
    const { service } = setup();
    await expect(service.forStudio('  ')).rejects.toThrow('studio id');
  });

  it('turns the GraphQL address into the site address', () => {
    expect(siteOf('https://stashdb.org/graphql')).toBe('https://stashdb.org');
    expect(siteOf('https://fansdb.cc/graphql/')).toBe('https://fansdb.cc');
  });
});
