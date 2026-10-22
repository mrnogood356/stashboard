import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { GrabReleaseDto } from './dto/grab-release.dto';
import { OwnedCopiesDto, OwnedCopiesQueryDto } from './dto/owned-copies.dto';
import { RequestOptionsDto } from './dto/request-options.dto';
import { SubmitSceneRequestDto } from './dto/submit-scene-request.dto';
import { SubmitSceneRequestResponseDto } from './dto/submit-scene-request-response.dto';
import { OwnedCopiesService } from './owned-copies.service';
import { RequestsService } from './requests.service';

@Controller('api/requests')
export class RequestsController {
  constructor(
    private readonly requestsService: RequestsService,
    private readonly ownedCopiesService: OwnedCopiesService,
  ) {}

  /**
   * Copies you likely already have, checked before a request or a download.
   * Never fails: an empty list just means no warning.
   */
  @Get(':stashId/owned')
  getOwnedCopies(
    @Param('stashId') stashId: string,
    @Query() query: OwnedCopiesQueryDto,
  ): Promise<OwnedCopiesDto> {
    return this.ownedCopiesService.findOwnedCopies(stashId, query.provider);
  }

  @Get(':stashId/options')
  getRequestOptions(
    @Param('stashId') stashId: string,
  ): Promise<RequestOptionsDto> {
    return this.requestsService.getRequestOptions(stashId);
  }

  @Get(':stashId/releases')
  getReleases(@Param('stashId') stashId: string) {
    return this.requestsService.getReleases(stashId);
  }

  @Post(':stashId/releases')
  grabRelease(@Param('stashId') stashId: string, @Body() body: GrabReleaseDto) {
    return this.requestsService.grabRelease(stashId, {
      guid: body.guid,
      indexerId: body.indexerId,
    });
  }

  @Post(':stashId')
  submitSceneRequest(
    @Param('stashId') stashId: string,
    @Body() payload: SubmitSceneRequestDto,
  ): Promise<SubmitSceneRequestResponseDto> {
    return this.requestsService.submitSceneRequest(stashId, payload);
  }
}
