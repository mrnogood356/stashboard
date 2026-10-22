import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { IntegrationStatus } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { DownloadHandoffService } from '../download-handoff/download-handoff.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { getRequestedCatalogProvider } from '../providers/catalog/catalog-provider-context';
import {
  ProwlarrAdapter,
  ProwlarrRelease,
} from '../providers/prowlarr/prowlarr.adapter';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { DownloadsService, sortProwlarrReleases } from './downloads.service';

function release(overrides: Partial<ProwlarrRelease> = {}): ProwlarrRelease {
  return {
    guid: 'g',
    indexerId: 1,
    indexer: 'Tracker',
    title: 'Some.Release',
    size: 1_000,
    protocol: 'torrent',
    seeders: 1,
    leechers: 0,
    ageHours: 10,
    publishDate: null,
    infoUrl: null,
    downloadUrl: null,
    ...overrides,
  };
}

describe('DownloadsService', () => {
  const findOne = jest.fn();
  const getSceneById = jest.fn();
  const search = jest.fn();
  const grab = jest.fn();
  const record = jest.fn();
  const fetchNzb = jest.fn();
  const handoff = { isActive: jest.fn(), send: jest.fn() };
  let requestedProvider: string | null = null;

  const catalog = {
    withDetailFallback: jest.fn(
      async (load: (provider: unknown) => Promise<unknown>) => {
        requestedProvider = getRequestedCatalogProvider();
        const provider = {
          integrationType: requestedProvider ?? 'STASHDB',
          providerKey: requestedProvider ?? 'STASHDB',
          baseUrl: 'http://catalog',
          apiKey: null,
        };
        return { value: await load(provider), provider, browseOnly: true };
      },
    ),
  };

  let service: DownloadsService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    requestedProvider = null;
    findOne.mockResolvedValue({
      enabled: true,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: 'http://prowlarr:9696',
      apiKey: 'key',
    });
    getSceneById.mockResolvedValue({
      id: 'scene-1',
      title: 'Beach Day',
      studioName: 'Jane Doe',
      releaseDate: '2024-03-15',
      performers: [{ name: 'Jane Doe' }],
    });
    service = new DownloadsService(
      { findOne } as unknown as IntegrationsService,
      catalog as unknown as CatalogProviderService,
      { getSceneById } as unknown as StashdbAdapter,
      { search, grab, fetchNzb } as unknown as ProwlarrAdapter,
    );
    handoff.isActive.mockResolvedValue(false);
    Object.assign(service, {
      activity: { record } as unknown as ActivityService,
      handoff: handoff as unknown as DownloadHandoffService,
    });
  });

  it('says whether Prowlarr is ready', async () => {
    await expect(service.getStatus()).resolves.toEqual({
      prowlarr: { configured: true },
    });

    findOne.mockRejectedValue(new NotFoundException());
    await expect(service.getStatus()).resolves.toEqual({
      prowlarr: { configured: false },
    });

    findOne.mockResolvedValue({
      enabled: true,
      status: IntegrationStatus.ERROR,
      baseUrl: 'http://prowlarr:9696',
      apiKey: null,
    });
    await expect(service.getStatus()).resolves.toEqual({
      prowlarr: { configured: false },
    });
  });

  it('refuses to search until Prowlarr is set up', async () => {
    findOne.mockRejectedValue(new NotFoundException());

    await expect(service.searchReleases('scene-1', 'FANSDB')).rejects.toThrow(
      ConflictException,
    );
    expect(search).not.toHaveBeenCalled();
  });

  it('searches a FansDB scene with a few queries, merges by guid and ranks by match', async () => {
    search.mockImplementation((_config: unknown, query: string) =>
      Promise.resolve(
        query === 'Jane Doe 24.03.15'
          ? [
              release({ guid: 'a', title: 'Other.Creator.Random.Clip' }),
              release({ guid: 'b', title: 'Jane.Doe.24.03.15.Beach.Day' }),
            ]
          : [release({ guid: 'b', title: 'Jane.Doe.24.03.15.Beach.Day' })],
      ),
    );

    const result = await service.searchReleases(' scene-1 ', 'FANSDB');

    expect(requestedProvider).toBe('FANSDB');
    expect(getSceneById).toHaveBeenCalledWith(
      'scene-1',
      expect.objectContaining({ integrationType: 'FANSDB' }),
    );
    expect(result.queries).toEqual(['Jane Doe 24.03.15', 'Jane Doe Beach Day']);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledWith(
      { baseUrl: 'http://prowlarr:9696', apiKey: 'key' },
      'Jane Doe 24.03.15',
    );
    expect(result.releases.map((entry) => entry.guid)).toEqual(['b', 'a']);
    expect(result.releases[0].match?.strength).toBe('strong');
    expect(result.releases[1].match?.strength).toBe('weak');
    expect(result.notice).toBeUndefined();
  });

  it('searches your own words as typed, instead of the built queries', async () => {
    search.mockResolvedValue([
      release({ guid: 'c', title: 'OnlyFans.Jane.Doe.Beach.Day.1080p' }),
    ]);

    const result = await service.searchReleases(
      'scene-1',
      'FANSDB',
      '  onlyfans jane doe beach ',
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(
      expect.anything(),
      'onlyfans jane doe beach',
    );
    expect(result.queries).toEqual(['onlyfans jane doe beach']);
    expect(result.releases.map((entry) => entry.guid)).toEqual(['c']);
  });

  it('keeps going when one query fails, and fails when all do', async () => {
    search
      .mockRejectedValueOnce(new Error('indexer down'))
      .mockResolvedValueOnce([release({ guid: 'x' })]);
    await expect(service.searchReleases('scene-1')).resolves.toMatchObject({
      releases: [{ guid: 'x' }],
    });

    search.mockRejectedValue(new Error('Prowlarr took too long to answer.'));
    await expect(service.searchReleases('scene-1')).rejects.toThrow(
      'Prowlarr took too long to answer.',
    );
  });

  it('says what it searched for when nothing came back', async () => {
    search.mockResolvedValue([]);

    const result = await service.searchReleases('scene-1', 'FANSDB');

    expect(result.releases).toEqual([]);
    expect(result.notice).toBe(
      'None of Prowlarr’s indexers found anything for “Jane Doe 24.03.15”, “Jane Doe Beach Day”.',
    );
  });

  it('grabs a release and notes it in the activity log', async () => {
    grab.mockResolvedValue(undefined);

    await expect(
      service.grabRelease(
        'scene-1',
        {
          guid: 'b',
          indexerId: 4,
          title: 'Jane.Doe.24.03.15.Beach.Day',
          indexer: 'Tracker',
        },
        'FANSDB',
      ),
    ).resolves.toEqual({ accepted: true, sentTo: 'prowlarr' });

    expect(grab).toHaveBeenCalledWith(
      { baseUrl: 'http://prowlarr:9696', apiKey: 'key' },
      { guid: 'b', indexerId: 4 },
    );
    expect(record).toHaveBeenCalledWith({
      kind: 'request',
      title: 'Sent a release of “Beach Day” to download through Prowlarr',
      detail:
        'Jane.Doe.24.03.15.Beach.Day, from Tracker, for “Beach Day” (FansDB).',
    });
  });

  describe('with Finished downloads on', () => {
    const usenet = release({
      guid: 'u',
      indexerId: 7,
      title: 'Jane.Doe.24.03.15.Beach.Day.1080p',
      protocol: 'usenet',
      downloadUrl: 'http://prowlarr:9696/7/download?apikey=key&link=abc',
    });

    beforeEach(() => {
      handoff.isActive.mockResolvedValue(true);
      handoff.send.mockResolvedValue({ id: 'h1' });
      fetchNzb.mockResolvedValue({
        content: new Uint8Array([1]),
        fileName: 'x.nzb',
      });
    });

    it('keeps the download link on the server', async () => {
      search.mockResolvedValue([usenet]);
      const result = await service.searchReleases('scene-1', 'FANSDB');
      expect(result.releases[0]).not.toHaveProperty('downloadUrl');
    });

    it('sends a usenet release’s NZB to SABnzbd for the exact scene', async () => {
      search.mockResolvedValue([usenet]);
      await service.searchReleases('scene-1', 'FANSDB');

      await expect(
        service.grabRelease(
          'scene-1',
          { guid: 'u', indexerId: 7, title: 'whatever the page said' },
          'FANSDB',
        ),
      ).resolves.toEqual({ accepted: true, sentTo: 'sabnzbd' });

      expect(fetchNzb).toHaveBeenCalledWith(
        { baseUrl: 'http://prowlarr:9696', apiKey: 'key' },
        'http://prowlarr:9696/7/download?apikey=key&link=abc',
      );
      expect(handoff.send).toHaveBeenCalledWith({
        nzb: { content: new Uint8Array([1]), fileName: 'x.nzb' },
        releaseTitle: 'Jane.Doe.24.03.15.Beach.Day.1080p',
        scene: { id: 'scene-1', provider: 'FANSDB', title: 'Beach Day' },
      });
      expect(grab).not.toHaveBeenCalled();
    });

    it('still sends torrents through Prowlarr', async () => {
      search.mockResolvedValue([release({ guid: 't', indexerId: 3 })]);
      await service.searchReleases('scene-1', 'FANSDB');

      await expect(
        service.grabRelease('scene-1', { guid: 't', indexerId: 3 }, 'FANSDB'),
      ).resolves.toEqual({ accepted: true, sentTo: 'prowlarr' });
      expect(grab).toHaveBeenCalled();
      expect(handoff.send).not.toHaveBeenCalled();
    });

    it('asks for a new search when the result is gone', async () => {
      await expect(
        service.grabRelease('scene-1', { guid: 'u', indexerId: 7 }, 'FANSDB'),
      ).rejects.toThrow('That search result has expired.');
      expect(grab).not.toHaveBeenCalled();
      expect(handoff.send).not.toHaveBeenCalled();
    });

    it('grabs through Prowlarr as before when it’s off', async () => {
      handoff.isActive.mockResolvedValue(false);
      search.mockResolvedValue([usenet]);
      await service.searchReleases('scene-1', 'FANSDB');

      await service.grabRelease('scene-1', { guid: 'u', indexerId: 7 });
      expect(grab).toHaveBeenCalledWith(expect.anything(), {
        guid: 'u',
        indexerId: 7,
      });
      expect(fetchNzb).not.toHaveBeenCalled();
    });
  });

  it('doesn’t log a grab Prowlarr refused', async () => {
    grab.mockRejectedValue(new Error('Couldn’t find requested release'));

    await expect(
      service.grabRelease('scene-1', { guid: 'b', indexerId: 4 }),
    ).rejects.toThrow('Couldn’t find requested release');
    expect(record).not.toHaveBeenCalled();
  });

  it('still logs the grab when the scene can’t be loaded afterwards', async () => {
    grab.mockResolvedValue(undefined);
    getSceneById.mockRejectedValue(new Error('catalog down'));

    await service.grabRelease('scene-1', {
      guid: 'b',
      indexerId: 4,
      title: 'Some.Release',
    });

    expect(record).toHaveBeenCalledWith({
      kind: 'request',
      title: 'Sent a release to download through Prowlarr',
      detail: 'Some.Release.',
    });
  });
});

describe('sortProwlarrReleases', () => {
  it('puts better matches first, then more seeders, then newer', () => {
    const sorted = sortProwlarrReleases([
      {
        ...release({ guid: 'weak', seeders: 99 }),
        match: { strength: 'weak', matched: [] },
      },
      { ...release({ guid: 'old', seeders: 5, ageHours: 100 }), match: null },
      { ...release({ guid: 'new', seeders: 5, ageHours: 1 }), match: null },
      {
        ...release({ guid: 'partial', seeders: 50 }),
        match: { strength: 'partial', matched: ['title'] },
      },
    ]);
    expect(sorted.map((entry) => entry.guid)).toEqual([
      'new',
      'old',
      'partial',
      'weak',
    ]);
  });
});
