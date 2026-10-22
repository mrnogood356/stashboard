import { Module } from '@nestjs/common';
import { HiddenContentController } from './hidden-content.controller';
import { HiddenContentService } from './hidden-content.service';

@Module({
  controllers: [HiddenContentController],
  providers: [HiddenContentService],
  exports: [HiddenContentService],
})
export class HiddenContentModule {}
