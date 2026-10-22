import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { IntegrationsService } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { getRequestedCatalogProvider } from '../providers/catalog/catalog-provider-context';
import {
  StashAdapter,
  type StashSceneCopy,
} from '../providers/stash/stash.adapter';
import {
  StashdbAdapter,
  type StashdbSceneFingerprints,
} from '../providers/stashdb/stashdb.adapter';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import {
  OwnedCopiesService,
  sameDuration,
  sameStudio,
  similarTitle,
} from './owned-copies.service';

type Criterion = Record<string, Record<string, unknown>>;

describe('OwnedCopiesService', () => {
  const configured = (baseUrl: string) => ({
    enabled: true,
    status: IntegrationStatus.CONFIGURED,
    baseUrl,
    apiKey: 'key',
  });
  let integrations: Partial<Record<IntegrationType, unknown>>;
  let identity: StashdbSceneFingerprints | null;
  let aliases: Array<{ stashId: string; aliasOf: string }>;
  let byCriterion: (criteria: Criterion[]) => StashSceneCopy[];
  let whisparrMovie: { movieId: number; hasFile: boolean } | null;
  let findSceneCopies: jest.Mock;
  let getSceneFingerprints: jest.Mock;
  let withDetailFallback: jest.Mock;
  let service: OwnedCopiesService;

  const copy = (id: string, extra: Partial<StashSceneCopy> = {}) => ({
    id,
    title: `Scene ${id}`,
    date: '2024-05-01',
    studioName: 'Studio',
    path: `/library/${id}.mp4`,
    screenshotVersion: 'v1',
    ...extra,
  });

  beforeEach(() => {
    integrations = {
      [IntegrationType.STASH]: configured('http://stash.local'),
      [IntegrationType.WHISPARR]: configured('http://whisparr.local'),
    };
    identity = {
      id: 'scene-1',
      title: 'Hot Summer Afternoon',
      studioName: 'Brazzers Exxtra',
      date: '2024-05-01',
      fingerprints: [
        { hash: 'os-1', algorithm: 'OSHASH', submissions: 9 },
        { hash: 'md5-1', algorithm: 'MD5', submissions: 3 },
        { hash: 'ph-1', algorithm: 'PHASH', submissions: 5 },
      ],
    };
    aliases = [];
    byCriterion = () => [];
    whisparrMovie = null;

    findSceneCopies = jest.fn((_config: unknown, criteria: Criterion[]) =>
      Promise.resolve(byCriterion(criteria)),
    );
    getSceneFingerprints = jest.fn(() => Promise.resolve(identity));
    withDetailFallback = jest.fn(
      async (load: (provider: unknown) => Promise<unknown>) => ({
        value: await load({ baseUrl: 'http://stashdb.local', apiKey: 'k' }),
        provider: { providerKey: 'STASHDB' },
        browseOnly: false,
      }),
    );

    service = new OwnedCopiesService(
      {
        findOne: jest.fn((type: IntegrationType) => {
          const integration = integrations[type];
          return integration
            ? Promise.resolve(integration)
            : Promise.reject(new Error('missing'));
        }),
      } as unknown as IntegrationsService,
      { withDetailFallback } as unknown as CatalogProviderService,
      { getSceneFingerprints } as unknown as StashdbAdapter,
      { findSceneCopies } as unknown as StashAdapter,
      {
        findMovieByStashId: jest.fn(() => Promise.resolve(whisparrMovie)),
        buildSceneViewUrl: jest.fn(
          (baseUrl: string, id: number) => `${baseUrl}/movie/${id}`,
        ),
      } as unknown as WhisparrAdapter,
      {
        sceneStashAlias: { findMany: jest.fn(() => Promise.resolve(aliases)) },
      } as unknown as PrismaService,
    );
  });

  it('warns about nothing when no lookup finds a copy', async () => {
    await expect(service.findOwnedCopies('scene-1')).resolves.toEqual({
      copies: [],
    });
  });

  it('finds a Stash scene linked to the scene, with its file and thumbnail', async () => {
    byCriterion = (criteria) =>
      criteria[0].stash_id_endpoint?.stash_id === 'scene-1' ? [copy('11')] : [];

    const result = await service.findOwnedCopies('scene-1');

    expect(result.copies).toEqual([
      {
        reason: 'LINKED',
        stashSceneId: '11',
        title: 'Scene 11',
        studio: 'Studio',
        date: '2024-05-01',
        path: '/library/11.mp4',
        imageUrl: '/api/media/stash/scenes/11/screenshot?v=v1&w=480',
        whisparrUrl: null,
      },
    ]);
  });

  it('finds scenes linked to a merged alias, either way round', async () => {
    aliases = [
      { stashId: 'scene-1', aliasOf: 'scene-old' },
      { stashId: 'scene-other', aliasOf: 'scene-1' },
    ];
    byCriterion = (criteria) =>
      criteria.length === 2 &&
      criteria.every((criterion) => criterion.stash_id_endpoint)
        ? [copy('22')]
        : [];

    const result = await service.findOwnedCopies('scene-1');

    expect(
      result.copies.map((entry) => [entry.reason, entry.stashSceneId]),
    ).toEqual([['MERGED', '22']]);
    const aliasCall = findSceneCopies.mock.calls.find(
      ([, criteria]: [unknown, Criterion[]]) => criteria.length === 2,
    ) as [unknown, Criterion[]];
    expect(
      aliasCall[1].map((criterion) => criterion.stash_id_endpoint.stash_id),
    ).toEqual(['scene-old', 'scene-other']);
  });

  it('matches file hashes and phashes in separate lookups', async () => {
    byCriterion = (criteria) =>
      criteria[0].oshash
        ? [copy('33')]
        : criteria[0].phash_distance
          ? [copy('44')]
          : [];

    const result = await service.findOwnedCopies('scene-1');

    expect(
      result.copies.map((entry) => [entry.reason, entry.stashSceneId]),
    ).toEqual([
      ['FINGERPRINT', '33'],
      ['FINGERPRINT', '44'],
    ]);
    expect(findSceneCopies).toHaveBeenCalledWith(expect.anything(), [
      { oshash: { value: 'os-1', modifier: 'EQUALS' } },
      { checksum: { value: 'md5-1', modifier: 'EQUALS' } },
    ]);
    expect(findSceneCopies).toHaveBeenCalledWith(expect.anything(), [
      { phash_distance: { value: 'ph-1', distance: 4, modifier: 'EQUALS' } },
    ]);
  });

  it('drops a near-phash match whose length is clearly different', async () => {
    identity = { ...identity!, duration: 1800 };
    byCriterion = (criteria) =>
      criteria[0].phash_distance
        ? [
            copy('44', { duration: 1802 }),
            copy('45', { duration: 95 }),
            copy('46', { duration: null }),
          ]
        : [];

    const result = await service.findOwnedCopies('scene-1');

    expect(result.copies.map((entry) => entry.stashSceneId)).toEqual([
      '44',
      '46',
    ]);
  });

  it('still answers file hashes when the phash lookup fails', async () => {
    findSceneCopies.mockImplementation(
      (_config: unknown, criteria: Criterion[]) =>
        criteria[0].phash_distance
          ? Promise.reject(new Error('Unknown field phash_distance'))
          : Promise.resolve(criteria[0].oshash ? [copy('33')] : []),
    );

    const result = await service.findOwnedCopies('scene-1');

    expect(result.copies.map((entry) => entry.stashSceneId)).toEqual(['33']);
  });

  it('matches a same-day scene by close title and studio only', async () => {
    byCriterion = (criteria) =>
      criteria[0].date
        ? [
            copy('55', {
              title: 'Hot Summer Afternoon!',
              studioName: 'BrazzersExxtra',
            }),
            copy('56', {
              title: 'Hot Summer Afternoon',
              studioName: 'Another Studio',
            }),
            copy('57', { title: 'Cold Winter', studioName: 'Brazzers Exxtra' }),
          ]
        : [];

    const result = await service.findOwnedCopies('scene-1');

    expect(
      result.copies.map((entry) => [entry.reason, entry.stashSceneId]),
    ).toEqual([['TITLE', '55']]);
    expect(findSceneCopies).toHaveBeenCalledWith(
      expect.anything(),
      [{ date: { value: '2024-05-01', modifier: 'EQUALS' } }],
      50,
    );
  });

  it('lists a scene once, under its strongest reason', async () => {
    byCriterion = (criteria) =>
      criteria[0].stash_id_endpoint || criteria[0].oshash || criteria[0].date
        ? [
            copy('11', {
              title: 'Hot Summer Afternoon',
              studioName: 'Brazzers Exxtra',
            }),
          ]
        : [];

    const result = await service.findOwnedCopies('scene-1');

    expect(result.copies).toHaveLength(1);
    expect(result.copies[0].reason).toBe('LINKED');
  });

  it('says when Whisparr already has a file', async () => {
    whisparrMovie = { movieId: 7, hasFile: true };

    const result = await service.findOwnedCopies('scene-1');

    expect(result.copies).toEqual([
      expect.objectContaining({
        reason: 'WHISPARR',
        stashSceneId: null,
        title: 'Hot Summer Afternoon',
        whisparrUrl: 'http://whisparr.local/movie/7',
      }),
    ]);
  });

  it('ignores a Whisparr scene with no file yet', async () => {
    whisparrMovie = { movieId: 7, hasFile: false };

    await expect(service.findOwnedCopies('scene-1')).resolves.toEqual({
      copies: [],
    });
  });

  it('skips Stash lookups when Stash is not set up, and still checks Whisparr', async () => {
    delete integrations[IntegrationType.STASH];
    whisparrMovie = { movieId: 7, hasFile: true };

    const result = await service.findOwnedCopies('scene-1');

    expect(findSceneCopies).not.toHaveBeenCalled();
    expect(result.copies.map((entry) => entry.reason)).toEqual(['WHISPARR']);
  });

  it('still checks links when the catalog scene cannot be loaded', async () => {
    getSceneFingerprints.mockRejectedValue(new Error('catalog down'));
    byCriterion = (criteria) =>
      criteria[0].stash_id_endpoint ? [copy('11')] : [];

    const result = await service.findOwnedCopies('scene-1');

    expect(result.copies.map((entry) => entry.reason)).toEqual(['LINKED']);
    expect(findSceneCopies).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ oshash: expect.anything() }),
      ]),
    );
  });

  it('asks the catalog the scene came from', async () => {
    let seen: unknown = null;
    withDetailFallback.mockImplementation(async () => {
      seen = getRequestedCatalogProvider();
      return { value: identity, provider: {}, browseOnly: true };
    });

    await service.findOwnedCopies('scene-1', 'FANSDB');

    expect(seen).toBe('FANSDB');
  });

  it('returns nothing for a blank id', async () => {
    await expect(service.findOwnedCopies('  ')).resolves.toEqual({
      copies: [],
    });
    expect(findSceneCopies).not.toHaveBeenCalled();
  });

  it('gives up on a lookup that takes too long', async () => {
    jest.useFakeTimers();
    try {
      findSceneCopies.mockImplementation(() => new Promise(() => undefined));
      const pending = service.findOwnedCopies('scene-1');
      await jest.advanceTimersByTimeAsync(9_000);

      await expect(pending).resolves.toEqual({ copies: [] });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('owned copy matching', () => {
  it('treats studios the same regardless of spaces, case and punctuation', () => {
    expect(sameStudio('Brazzers Exxtra', 'brazzersexxtra')).toBe(true);
    expect(sameStudio('Brazzers', 'Brazzers Exxtra')).toBe(false);
    expect(sameStudio('', '')).toBe(false);
  });

  it('treats titles as close when equal or one long one contains the other', () => {
    expect(similarTitle('Hot Summer Afternoon', 'hot summer afternoon!')).toBe(
      true,
    );
    expect(
      similarTitle('Hot Summer Afternoon', 'Hot Summer Afternoon, Part 2'),
    ).toBe(true);
    expect(similarTitle('Hot', 'Hot Summer')).toBe(false);
    expect(similarTitle('Café Scene', 'Cafe scene')).toBe(true);
    expect(similarTitle(null, 'x')).toBe(false);
  });

  it('treats lengths as the same within a few seconds, or when one is unknown', () => {
    expect(sameDuration(600, 604)).toBe(true);
    expect(sameDuration(600, 660)).toBe(false);
    expect(sameDuration(null, 660)).toBe(true);
    expect(sameDuration(0, 660)).toBe(true);
  });
});
