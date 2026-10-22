import { PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  SceneTimelineController,
  SceneTimelinesQueryDto,
} from './scene-timeline.controller';
import { SceneTimelineService } from './scene-timeline.service';

describe('SceneTimelineController', () => {
  const service = { forScene: jest.fn(), forScenes: jest.fn() };
  const controller = new SceneTimelineController(
    service as unknown as SceneTimelineService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('serves one scene next to its evidence, and a batch for Acquisition', () => {
    const path = (name: 'scene' | 'scenes') =>
      Reflect.getMetadata(
        PATH_METADATA,
        SceneTimelineController.prototype[name],
      ) as string;
    expect(Reflect.getMetadata(PATH_METADATA, SceneTimelineController)).toBe(
      'api/scenes',
    );
    expect(path('scene')).toBe(':stashId/timeline');
    expect(path('scenes')).toBe('timelines');
  });

  it('asks for one scene by its catalog id', async () => {
    service.forScene.mockResolvedValue({ stashId: 'sdb-1', steps: [] });

    await expect(controller.scene('sdb-1')).resolves.toEqual({
      stashId: 'sdb-1',
      steps: [],
    });
    expect(service.forScene).toHaveBeenCalledWith('sdb-1');
  });

  it('wraps the batch in items', async () => {
    service.forScenes.mockResolvedValue([{ stashId: 'sdb-1' }]);

    await expect(controller.scenes({ ids: ['sdb-1'] })).resolves.toEqual({
      items: [{ stashId: 'sdb-1' }],
    });
  });

  it('takes at most a page of ids', async () => {
    const tooMany = plainToInstance(SceneTimelinesQueryDto, {
      ids: Array.from({ length: 51 }, (_, index) => `id-${index}`),
    });
    const fine = plainToInstance(SceneTimelinesQueryDto, { ids: ['sdb-1'] });

    expect(await validate(tooMany)).not.toHaveLength(0);
    expect(await validate(fine)).toHaveLength(0);
  });
});
