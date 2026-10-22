import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StashModule } from '../providers/stash/stash.module';
import { MediaCacheService } from './media-cache.service';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [PrismaModule, StashModule],
  controllers: [MediaController],
  providers: [MediaService, MediaCacheService],
})
export class MediaModule {}
