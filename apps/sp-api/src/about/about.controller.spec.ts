import { AboutController } from './about.controller';
import { AboutService } from './about.service';
import { UpdateCheckService } from './update-check.service';

describe('AboutController', () => {
  it('passes each part through from its service', async () => {
    const about = {
      about: jest.fn().mockReturnValue({ build: {}, recentErrors: [] }),
      health: jest.fn().mockResolvedValue({ jobs: [] }),
    };
    const updates = {
      check: jest.fn().mockResolvedValue({ status: 'unknown' }),
    };
    const controller = new AboutController(
      about as unknown as AboutService,
      updates as unknown as UpdateCheckService,
    );

    expect(controller.get()).toEqual({ build: {}, recentErrors: [] });
    await expect(controller.health()).resolves.toEqual({ jobs: [] });
    await expect(controller.update()).resolves.toEqual({ status: 'unknown' });
  });
});
