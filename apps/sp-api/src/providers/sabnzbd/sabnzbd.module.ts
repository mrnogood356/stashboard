import { Module } from '@nestjs/common';
import { SabnzbdAdapter } from './sabnzbd.adapter';

@Module({
  providers: [SabnzbdAdapter],
  exports: [SabnzbdAdapter],
})
export class SabnzbdModule {}
