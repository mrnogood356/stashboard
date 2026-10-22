import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApplyMatchDto,
  LookupScenesDto,
  MoveUnmatchedDto,
  OrganizerPageQueryDto,
  PickedScenesDto,
  RenamePreviewDto,
  RenameScenesDto,
  ScrapeSceneDto,
  UpdateOrganizerSettingsDto,
} from './dto/organizer.dto';
import { OrganizerService } from './organizer.service';

/** Match unmatched scenes to StashDB and rename files into tidy folders. */
@Controller('api/organizer')
export class OrganizerController {
  constructor(private readonly organizer: OrganizerService) {}

  @Get()
  settings() {
    return this.organizer.getSettingsDto();
  }

  @Put()
  update(@Body() body: UpdateOrganizerSettingsDto) {
    return this.organizer.updateSettings(body);
  }

  @Get('status')
  status() {
    return this.organizer.status();
  }

  @Get('unmatched')
  unmatched(@Query() query: OrganizerPageQueryDto) {
    return this.organizer.unmatched(query.page ?? 1, {
      q: query.q,
      sort: query.sort,
      scope: query.scope,
    });
  }

  @Post('lookup')
  @HttpCode(200)
  lookup(@Body() body: LookupScenesDto) {
    return this.organizer.lookup(body.sceneIds, body.query);
  }

  @Post('apply')
  @HttpCode(200)
  apply(@Body() body: ApplyMatchDto) {
    return this.organizer.apply(body.sceneId, body.candidateId);
  }

  @Post('scrape')
  @HttpCode(200)
  scrape(@Body() body: ScrapeSceneDto) {
    return this.organizer.scrapeOne(body.sceneId);
  }

  @Post('whisparr/send-all')
  @HttpCode(202)
  sendAllToWhisparr() {
    return this.organizer.startSendAll();
  }

  @Post('whisparr/detect')
  @HttpCode(200)
  detectWhisparrPath() {
    return this.organizer.detectWhisparrPath();
  }

  @Get('whisparr/relocate')
  whisparrRelocation() {
    return this.organizer.whisparrRelocation();
  }

  @Post('whisparr/relocate')
  @HttpCode(202)
  relocateWhisparr() {
    return this.organizer.startWhisparrRelocation();
  }

  @Get('whisparr/naming')
  whisparrNaming() {
    return this.organizer.whisparrNaming();
  }

  @Get('whisparr/repair')
  whisparrRepairCount() {
    return this.organizer.whisparrRepairCount();
  }

  @Post('whisparr/repair')
  @HttpCode(202)
  repairWhisparr() {
    return this.organizer.startWhisparrRepair();
  }

  @Post('whisparr/check')
  @HttpCode(200)
  checkWhisparrPath() {
    return this.organizer.checkWhisparrPath();
  }

  /** Rescan, remove extra copies, link scenes waiting for import. */
  @Post('whisparr/sync')
  @HttpCode(202)
  syncWithWhisparr() {
    return this.organizer.startWhisparrSync();
  }

  @Post('waiting/check')
  @HttpCode(200)
  checkWaiting() {
    return this.organizer.checkWaitingScenes();
  }

  @Post('waiting/:stashId/same-scene')
  @HttpCode(200)
  markSameScene(@Param('stashId', ParseUUIDPipe) stashId: string) {
    return this.organizer.markSameScene(stashId);
  }

  @Post('unmatched/move')
  @HttpCode(202)
  moveUnmatched(@Body() body: MoveUnmatchedDto) {
    return this.organizer.startMoveUnmatched(body?.sceneIds);
  }

  @Get('folders/empty')
  emptyFolders() {
    return this.organizer.emptyFolders();
  }

  @Post('folders/clean')
  @HttpCode(200)
  cleanEmptyFolders() {
    return this.organizer.cleanEmptyFoldersNow();
  }

  @Post('match-all')
  @HttpCode(202)
  matchAll() {
    return this.organizer.startAutoMatch('manual');
  }

  /** Sure matches only, for the scenes picked in the Match list. */
  @Get('proposals')
  proposals() {
    return this.organizer.matchProposals();
  }

  @Post('proposals/save')
  @HttpCode(202)
  saveProposals(@Body() body: PickedScenesDto) {
    return this.organizer.startSaveProposals(body.sceneIds);
  }

  @Post('proposals/choose')
  @HttpCode(200)
  chooseProposal(@Body() body: ApplyMatchDto) {
    return this.organizer.chooseProposal(body.sceneId, body.candidateId);
  }

  @Post('proposals/dismiss')
  @HttpCode(200)
  dismissProposals(@Body() body: PickedScenesDto) {
    return this.organizer.dismissProposals(body.sceneIds);
  }

  @Post('match-selected')
  @HttpCode(202)
  matchSelected(@Body() body: PickedScenesDto) {
    return this.organizer.startAutoMatch('manual', body.sceneIds);
  }

  @Post('rename/taken/fix')
  @HttpCode(200)
  fixTaken(@Body() body: PickedScenesDto) {
    return this.organizer.fixTaken(body.sceneIds);
  }

  @Post('rename/preview')
  @HttpCode(200)
  preview(@Body() body: RenamePreviewDto) {
    return this.organizer.renamePreview(body.pattern);
  }

  @Post('rename')
  @HttpCode(200)
  rename(@Body() body: RenameScenesDto) {
    return this.organizer.renameSelected(body.sceneIds);
  }

  @Post('rename/remove-copies')
  removeExtraCopies() {
    return this.organizer.removeExtraCopies();
  }

  @Post('rename-all')
  @HttpCode(202)
  renameAll() {
    return this.organizer.startRenameAll();
  }

  @Post('undo')
  @HttpCode(202)
  undo() {
    return this.organizer.undoLast();
  }
}
