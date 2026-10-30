import { AboutController } from './about.controller';
import { AboutService } from './about.service';
import { ReleaseNotesService } from './release-notes.service';
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
    const releaseNotes = {
      since: jest.fn().mockReturnValue({ current: '1.3.0', releases: [] }),
    };
    const controller = new AboutController(
      about as unknown as AboutService,
      updates as unknown as UpdateCheckService,
      releaseNotes as unknown as ReleaseNotesService,
    );

    expect(controller.get()).toEqual({ build: {}, recentErrors: [] });
    await expect(controller.health()).resolves.toEqual({ jobs: [] });
    await expect(controller.update()).resolves.toEqual({ status: 'unknown' });
    expect(controller.changes({ since: '1.2.0' })).toEqual({
      current: '1.3.0',
      releases: [],
    });
    expect(releaseNotes.since).toHaveBeenCalledWith('1.2.0');
  });
});
