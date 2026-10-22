import { Module } from '@nestjs/common';
import { AppearanceController } from './appearance.controller';
import { AppearanceService } from './appearance.service';

/** Settings → Appearance: the theme, saved on the server for every device. */
@Module({
  controllers: [AppearanceController],
  providers: [AppearanceService],
})
export class AppearanceModule {}
