import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ExceptionLoggingFilter } from '../logging/exception-logging.filter';
import { LogsController } from './logs.controller';
import { LogsService } from './logs.service';

/** Settings → Logs, and logging every server error with its request. */
@Module({
  controllers: [LogsController],
  providers: [
    LogsService,
    { provide: APP_FILTER, useClass: ExceptionLoggingFilter },
  ],
  exports: [LogsService],
})
export class LogsModule {}
