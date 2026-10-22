import { Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module';
import { OrganizerModule } from '../organizer/organizer.module';
import { StashModule } from '../providers/stash/stash.module';
import {
  AutomationController,
  AutomationWebhookController,
} from './automation.controller';
import { AutomationService } from './automation.service';

@Module({
  imports: [StashModule, IndexingModule, OrganizerModule],
  controllers: [AutomationController, AutomationWebhookController],
  providers: [AutomationService],
})
export class AutomationModule {}
