import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ServiceDiscoveryService } from './service-discovery.service';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({
  imports: [IntegrationsModule],
  controllers: [SetupController],
  providers: [
    SetupService,
    // Built by hand: its constructor takes test seams, not injectables.
    {
      provide: ServiceDiscoveryService,
      useFactory: () => new ServiceDiscoveryService(),
    },
  ],
})
export class SetupModule {}
