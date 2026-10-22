import { ValidationPipe } from '@nestjs/common';
import type { DownloadDropInService } from './download-drop-in.service';
import { DownloadHandoffController } from './download-handoff.controller';
import { DownloadHandoffService } from './download-handoff.service';
import { DownloadProcessingController } from './download-processing.controller';
import type { DownloadProcessingService } from './download-processing.service';
import { UpdateDownloadHandoffDto } from './dto/update-download-handoff.dto';

/** The same pipe the app uses (see app.setup.ts). */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validate = (value: unknown) =>
  pipe.transform(value, {
    type: 'body',
    metatype: UpdateDownloadHandoffDto,
  }) as Promise<UpdateDownloadHandoffDto>;

describe('DownloadHandoffController', () => {
  const service = {
    getSettingsDto: jest.fn(),
    updateSettings: jest.fn(),
    recent: jest.fn(),
    ignore: jest.fn(),
  };
  const dropIns = { recent: jest.fn().mockResolvedValue([]) };
  const controller = new DownloadHandoffController(
    service as unknown as DownloadHandoffService,
    dropIns as unknown as DownloadDropInService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('passes only the settings fields on', async () => {
    const body = await validate({
      enabled: true,
      destination: '/data/downloads',
      importMode: 'copy',
      dropIns: true,
      sabManualJobs: false,
    });
    await controller.update(body);
    expect(service.updateSettings).toHaveBeenCalledWith({
      enabled: true,
      category: undefined,
      destination: '/data/downloads',
      sabPathFrom: undefined,
      sabPathTo: undefined,
      importMode: 'copy',
      dropIns: true,
      sabManualJobs: false,
    });
  });

  it('lists the videos brought in from SABnzbd’s folder', async () => {
    await controller.dropIns();
    expect(dropIns.recent).toHaveBeenCalled();
  });

  describe('Processing', () => {
    const processing = { snapshot: jest.fn().mockResolvedValue({ ok: 1 }) };
    const handoff = { retry: jest.fn().mockResolvedValue({}) };
    const watcher = {
      checkNow: jest.fn().mockResolvedValue({}),
      retry: jest.fn(),
    };
    const processingController = new DownloadProcessingController(
      processing as unknown as DownloadProcessingService,
      handoff as unknown as DownloadHandoffService,
      watcher as unknown as DownloadDropInService,
    );

    it('checks the drop-in folder now and answers with everything', async () => {
      await expect(processingController.checkDropIns()).resolves.toEqual({
        ok: 1,
      });
      expect(watcher.checkNow).toHaveBeenCalled();
    });

    it('retries a download or a drop-in', async () => {
      await processingController.retryHandoff('h1');
      expect(handoff.retry).toHaveBeenCalledWith('h1');

      // Forgotten so it's picked up again: looked for straight away.
      watcher.retry.mockResolvedValue(null);
      await processingController.retryDropIn('d1');
      expect(watcher.retry).toHaveBeenCalledWith('d1');
      expect(watcher.checkNow).toHaveBeenCalled();
    });
  });

  it('refuses an unknown import mode or field', async () => {
    await expect(validate({ importMode: 'hardlink' })).rejects.toThrow();
    await expect(validate({ deleteFromSab: true })).rejects.toThrow();
    await expect(validate({ dropIns: 'yes' })).rejects.toThrow();
    await expect(validate({ sabManualJobs: 'on' })).rejects.toThrow();
    // The cutoff is Stashboard's to set, never the client's.
    await expect(
      validate({ sabManualSince: '2020-01-01T00:00:00Z' }),
    ).rejects.toThrow();
    await expect(validate({ sabManualJobs: true })).resolves.toMatchObject({
      sabManualJobs: true,
    });
  });
});
