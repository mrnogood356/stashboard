import { PATH_METADATA } from '@nestjs/common/constants';
import { SceneEvidenceController } from './scene-evidence.controller';
import { SceneEvidenceService } from './scene-evidence.service';

describe('SceneEvidenceController', () => {
  const service = {
    forCatalogScene: jest.fn(),
    forLocalScene: jest.fn(),
  };
  const controller = new SceneEvidenceController(
    service as unknown as SceneEvidenceService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('serves both kinds of scene next to their pages’ own routes', () => {
    const path = (name: 'catalogScene' | 'localScene') =>
      Reflect.getMetadata(
        PATH_METADATA,
        SceneEvidenceController.prototype[name],
      ) as string;
    expect(Reflect.getMetadata(PATH_METADATA, SceneEvidenceController)).toBe(
      'api',
    );
    expect(path('catalogScene')).toBe('scenes/:stashId/evidence');
    expect(path('localScene')).toBe('local/scenes/:sceneId/evidence');
  });

  it('asks about a catalog scene by its catalog id', async () => {
    service.forCatalogScene.mockResolvedValue({ kind: 'catalog', id: 'sdb-1' });

    await expect(controller.catalogScene('sdb-1')).resolves.toEqual({
      kind: 'catalog',
      id: 'sdb-1',
    });
    expect(service.forCatalogScene).toHaveBeenCalledWith('sdb-1');
  });

  it('asks about a library scene by its Stash id', async () => {
    service.forLocalScene.mockResolvedValue({ kind: 'local', id: '12' });

    await expect(controller.localScene('12')).resolves.toEqual({
      kind: 'local',
      id: '12',
    });
    expect(service.forLocalScene).toHaveBeenCalledWith('12');
  });
});
