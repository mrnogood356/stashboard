import { IntegrationStatus } from '@prisma/client';
import type { IntegrationsService } from '../integrations/integrations.service';
import type {
  WhisparrAdapter,
  WhisparrImportProblem,
  WhisparrManualImportFile,
} from '../providers/whisparr/whisparr.adapter';
import { WhisparrImportsService } from './whisparr-imports.service';

function problem(
  overrides: Partial<WhisparrImportProblem> = {},
): WhisparrImportProblem {
  return {
    queueId: 7,
    downloadId: 'SABnzbd_nzo_1',
    title: 'Jane.Doe.Beach.Day.1080p',
    movieId: 42,
    movieTitle: 'Beach Day',
    state: 'importBlocked',
    status: 'completed',
    messages: ['Not an upgrade for existing movie file'],
    outputPath: '/downloads/complete/Jane.Doe.Beach.Day.1080p',
    added: '2026-11-01T10:00:00Z',
    ...overrides,
  };
}

function file(
  overrides: Partial<WhisparrManualImportFile> = {},
): WhisparrManualImportFile {
  return {
    path: '/downloads/complete/Jane.Doe.Beach.Day.1080p/scene.mp4',
    name: 'scene.mp4',
    size: 1000,
    movieId: null,
    movieTitle: null,
    quality: { quality: { id: 7 } },
    languages: [],
    releaseGroup: null,
    rejections: [],
    ...overrides,
  };
}

function setup(
  problems: WhisparrImportProblem[],
  files: WhisparrManualImportFile[] = [],
) {
  const whisparr = {
    getImportProblems: jest.fn().mockResolvedValue(problems),
    getManualImportFiles: jest.fn().mockResolvedValue(files),
    startManualImport: jest.fn().mockResolvedValue(1),
    removeQueueItem: jest.fn().mockResolvedValue(undefined),
  };
  const integrations = {
    findOne: jest.fn().mockResolvedValue({
      enabled: true,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: 'http://whisparr:6969/',
      apiKey: 'k',
    }),
  };
  const service = new WhisparrImportsService(
    integrations as unknown as IntegrationsService,
    whisparr as unknown as WhisparrAdapter,
  );
  return { service, whisparr };
}

describe('WhisparrImportsService', () => {
  it('lists stuck downloads, importable only when Whisparr knows the scene', async () => {
    const { service } = setup([
      problem(),
      problem({ queueId: 8, movieId: null, movieTitle: null }),
    ]);

    const result = await service.list();

    expect(result.whisparrQueueUrl).toBe('http://whisparr:6969/activity/queue');
    expect(result.items.map((item) => item.canImport)).toEqual([true, false]);
  });

  it('imports the videos Whisparr can tie to the scene, leaving samples out', async () => {
    const { service, whisparr } = setup(
      [problem()],
      [file(), file({ path: '/x/sample.mp4', rejections: ['Sample'] })],
    );

    await service.import(7);

    expect(whisparr.startManualImport).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          movieId: 42,
          downloadId: 'SABnzbd_nzo_1',
          item: expect.objectContaining({ name: 'scene.mp4' }),
        }),
      ],
      'auto',
    );
  });

  it('says to pick the scene in Whisparr when it can’t tell which it is', async () => {
    const { service, whisparr } = setup([problem({ movieId: null })], [file()]);

    await expect(service.import(7)).rejects.toThrow('Manual Import');
    expect(whisparr.startManualImport).not.toHaveBeenCalled();
  });

  it('removes one from the queue, and from the download client when asked', async () => {
    const { service, whisparr } = setup([problem()]);

    await service.remove(7, true);

    expect(whisparr.removeQueueItem).toHaveBeenCalledWith(
      expect.anything(),
      7,
      true,
    );
  });
});
