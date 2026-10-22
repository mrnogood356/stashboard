import { Module } from '@nestjs/common';
import { ProwlarrAdapter } from './prowlarr.adapter';

@Module({
  providers: [ProwlarrAdapter],
  exports: [ProwlarrAdapter],
})
export class ProwlarrModule {}
