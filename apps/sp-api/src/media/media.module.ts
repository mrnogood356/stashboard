import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StashModule } from '../providers/stash/stash.module';
import { MediaCacheService } from './media-cache.service';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { ArtworkColorService } from './artwork-color.service';

@Module({
  imports: [PrismaModule, StashModule],
  controllers: [MediaController],
  providers: [MediaService, MediaCacheService, ArtworkColorService],
})
export class MediaModule {}
