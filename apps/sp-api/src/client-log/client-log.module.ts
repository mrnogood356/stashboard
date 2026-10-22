import { Module } from '@nestjs/common';
import { ClientLogController } from './client-log.controller';

@Module({ controllers: [ClientLogController] })
export class ClientLogModule {}
