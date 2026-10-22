import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { DownloadsController } from './downloads.controller';
import { DownloadsService } from './downloads.service';
import { GrabDownloadDto } from './dto/grab-download.dto';
import { ReleaseSearchQueryDto } from './dto/release-search-query.dto';

/** The same pipe the app uses (see app.setup.ts). */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

function validate<T>(
  metatype: new () => T,
  type: ArgumentMetadata['type'],
  value: unknown,
): Promise<T> {
  return pipe.transform(value, { type, metatype }) as Promise<T>;
}

describe('DownloadsController', () => {
  const service = {
    getStatus: jest.fn(),
    searchReleases: jest.fn(),
    grabRelease: jest.fn(),
  };
  const controller = new DownloadsController(
    service as unknown as DownloadsService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('passes the scene and its catalog to the search', async () => {
    service.searchReleases.mockResolvedValue({ releases: [], queries: [] });
    const query = await validate(ReleaseSearchQueryDto, 'query', {
      provider: 'fansdb',
    });

    await controller.searchReleases('scene-1', query);

    expect(service.searchReleases).toHaveBeenCalledWith(
      'scene-1',
      'FANSDB',
      undefined,
    );
  });

  it('passes your own search words, trimmed', async () => {
    service.searchReleases.mockResolvedValue({ releases: [], queries: [] });
    const query = await validate(ReleaseSearchQueryDto, 'query', {
      provider: 'FANSDB',
      q: '  jane doe beach  ',
    });

    await controller.searchReleases('scene-1', query);

    expect(service.searchReleases).toHaveBeenCalledWith(
      'scene-1',
      'FANSDB',
      'jane doe beach',
    );
  });

  it('passes only the release fields on a grab', async () => {
    service.grabRelease.mockResolvedValue({ accepted: true });
    const body = await validate(GrabDownloadDto, 'body', {
      guid: 'g1',
      indexerId: 4,
      provider: 'FANSDB',
      title: 'Jane.Doe.Beach.Day',
      indexer: 'Tracker',
    });

    await controller.grabRelease('scene-1', body);

    expect(service.grabRelease).toHaveBeenCalledWith(
      'scene-1',
      {
        guid: 'g1',
        indexerId: 4,
        title: 'Jane.Doe.Beach.Day',
        indexer: 'Tracker',
      },
      'FANSDB',
    );
  });

  it('refuses an unknown catalog', async () => {
    await expect(
      validate(ReleaseSearchQueryDto, 'query', { provider: 'TPDB' }),
    ).rejects.toThrow();
  });

  it('refuses a grab without a guid or with a bad indexer id', async () => {
    await expect(
      validate(GrabDownloadDto, 'body', { indexerId: 4 }),
    ).rejects.toThrow();
    await expect(
      validate(GrabDownloadDto, 'body', { guid: 'g', indexerId: 'four' }),
    ).rejects.toThrow();
    await expect(
      validate(GrabDownloadDto, 'body', { guid: 'g', indexerId: -1 }),
    ).rejects.toThrow();
  });

  it('refuses fields it doesn’t know', async () => {
    await expect(
      validate(GrabDownloadDto, 'body', {
        guid: 'g',
        indexerId: 1,
        downloadClientId: 3,
      }),
    ).rejects.toThrow();
  });
});
