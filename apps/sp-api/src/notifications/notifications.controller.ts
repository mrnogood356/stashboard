import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import {
  NotificationSettingsDto,
  UpdateNotificationSettingsDto,
} from './dto/notification-settings.dto';
import { NotificationsService } from './notifications.service';

@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('settings')
  getSettings(): Promise<NotificationSettingsDto> {
    return this.notificationsService.getSettings();
  }

  @Put('settings')
  updateSettings(
    @Body() body: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettingsDto> {
    return this.notificationsService.updateSettings(body);
  }

  @Post('test')
  @HttpCode(204)
  async sendTest(@Body() body: UpdateNotificationSettingsDto): Promise<void> {
    await this.notificationsService.sendTest(body);
  }
}
