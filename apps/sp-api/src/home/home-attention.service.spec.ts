import { Logger } from '@nestjs/common';
import { SceneLifecycle } from '@prisma/client';
import { OrganizerService } from '../organizer/organizer.service';
import { LocalLibraryService } from '../playback/local-library.service';
import { PrismaService } from '../prisma/prisma.service';
import { HomeAttentionService } from './home-attention.service';

describe('HomeAttentionService', () => {
  let groupBy: jest.Mock;
  let proposalCount: jest.Mock;
  let fixCounts: jest.Mock;
  let service: HomeAttentionService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    groupBy = jest.fn().mockResolvedValue([
      { computedLifecycle: SceneLifecycle.FAILED, _count: { _all: 3 } },
      { computedLifecycle: SceneLifecycle.IMPORT_PENDING, _count: { _all: 2 } },
    ]);
    proposalCount = jest.fn().mockResolvedValue(2);
    fixCounts = jest
      .fn()
      .mockResolvedValue({ unmatched: 7, untagged: 1, unorganized: 4 });
    service = new HomeAttentionService(
      { sceneIndex: { groupBy } } as unknown as PrismaService,
      { proposalCount } as unknown as OrganizerService,
      { fixCounts } as unknown as LocalLibraryService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns every count', async () => {
    await expect(service.getAttention()).resolves.toEqual({
      matchesToCheck: 2,
      failed: 3,
      waitingForImport: 2,
      unmatched: 7,
    });
    expect(groupBy).toHaveBeenCalledWith({
      by: ['computedLifecycle'],
      where: {
        computedLifecycle: {
          in: [SceneLifecycle.FAILED, SceneLifecycle.IMPORT_PENDING],
        },
      },
      _count: { _all: true },
    });
  });

  it('counts zero for a lifecycle with no scenes', async () => {
    groupBy.mockResolvedValue([]);

    await expect(service.getAttention()).resolves.toMatchObject({
      failed: 0,
      waitingForImport: 0,
    });
  });

  it('gives null for each source that is down, keeping the others', async () => {
    groupBy.mockRejectedValue(new Error('db down'));
    proposalCount.mockRejectedValue(new Error('organizer broke'));

    await expect(service.getAttention()).resolves.toEqual({
      matchesToCheck: null,
      failed: null,
      waitingForImport: null,
      unmatched: 7,
    });
  });

  it('gives null unmatched when Stash cannot be reached', async () => {
    fixCounts.mockRejectedValue(new Error('stash down'));

    await expect(service.getAttention()).resolves.toEqual({
      matchesToCheck: 2,
      failed: 3,
      waitingForImport: 2,
      unmatched: null,
    });
  });
});
