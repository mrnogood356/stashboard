import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityModule } from './activity.module';
import { ActivityService } from './activity.service';

/** Like OrganizerCore: the log is a property on a base class. */
abstract class Base {
  @Optional()
  @Inject(ActivityService)
  readonly activity?: ActivityService;
}

@Injectable()
class SomeService extends Base {}

@Module({ providers: [SomeService] })
class SomeModule {}

describe('ActivityModule', () => {
  it('gives any module the log without importing it', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, ActivityModule, SomeModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    expect(moduleRef.get(SomeService).activity).toBe(
      moduleRef.get(ActivityService),
    );
  });

  it('leaves it out when the log isn’t there', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SomeModule],
    }).compile();
    expect(moduleRef.get(SomeService).activity).toBeUndefined();
  });
});
