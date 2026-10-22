import { Controller, Get, Param } from '@nestjs/common';
import type { SceneEvidenceDto } from './scene-evidence.model';
import { SceneEvidenceService } from './scene-evidence.service';

/** "Why is it like this?": what Stashboard sees for one scene. */
@Controller('api')
export class SceneEvidenceController {
  constructor(private readonly evidence: SceneEvidenceService) {}

  /** A StashDB/FansDB scene, by its catalog id. */
  @Get('scenes/:stashId/evidence')
  catalogScene(@Param('stashId') stashId: string): Promise<SceneEvidenceDto> {
    return this.evidence.forCatalogScene(stashId);
  }

  /** A scene in your Stash library, by its Stash id. */
  @Get('local/scenes/:sceneId/evidence')
  localScene(@Param('sceneId') sceneId: string): Promise<SceneEvidenceDto> {
    return this.evidence.forLocalScene(sceneId);
  }
}
