import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  const findUniqueMock = jest.fn();
  const upsertMock = jest.fn();
  const prisma = {
    notificationSettings: { findUnique: findUniqueMock, upsert: upsertMock },
  } as unknown as PrismaService;
  const fetchMock = jest.fn();
  let service: NotificationsService;

  const enabledSettings = (overrides: Record<string, unknown> = {}) => ({
    key: 'GLOBAL',
    enabled: true,
    channel: 'DISCORD',
    url: 'https://discord.com/api/webhooks/1/abc',
    notifyDownloading: true,
    notifyAvailable: true,
    notifyFailed: true,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock;
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    service = new NotificationsService(prisma);
  });

  it('returns safe defaults before anything is saved', async () => {
    findUniqueMock.mockResolvedValue(null);
    await expect(service.getSettings()).resolves.toEqual({
      enabled: false,
      channel: 'DISCORD',
      url: null,
      notifyDownloading: false,
      notifyAvailable: true,
      notifyFailed: true,
    });
  });

  it('refuses to enable without a URL and rejects non-http URLs', async () => {
    const base = {
      channel: 'DISCORD' as const,
      notifyDownloading: false,
      notifyAvailable: true,
      notifyFailed: true,
    };
    await expect(
      service.updateSettings({ ...base, enabled: true, url: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateSettings({
        ...base,
        enabled: false,
        url: 'file:///etc/passwd',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('sends one Discord embed per event type, listing titles', async () => {
    findUniqueMock.mockResolvedValue(enabledSettings());

    await service.notifySceneChanges([
      { event: 'AVAILABLE', title: 'Scene A' },
      { event: 'AVAILABLE', title: 'Scene B' },
      { event: 'FAILED', title: 'Scene C' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(first.embeds[0]).toEqual(
      expect.objectContaining({
        title: '2 scenes are now in your library',
        description: '• Scene A\n• Scene B',
      }),
    );
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(second.embeds[0]).toEqual(
      expect.objectContaining({
        title: 'Download failed',
        description: 'Scene C',
      }),
    );
  });

  it('summarises long lists instead of flooding', async () => {
    findUniqueMock.mockResolvedValue(enabledSettings());
    await service.notifySceneChanges(
      Array.from({ length: 12 }, (_, i) => ({
        event: 'AVAILABLE' as const,
        title: `S${i}`,
      })),
    );
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.embeds[0].title).toBe('12 scenes are now in your library');
    expect(payload.embeds[0].description).toContain('…and 7 more');
  });

  it('respects per-event toggles and the master switch', async () => {
    findUniqueMock.mockResolvedValue(
      enabledSettings({ notifyDownloading: false }),
    );
    await service.notifySceneChanges([{ event: 'DOWNLOADING', title: 'X' }]);
    expect(fetchMock).not.toHaveBeenCalled();

    findUniqueMock.mockResolvedValue(enabledSettings({ enabled: false }));
    await service.notifySceneChanges([{ event: 'AVAILABLE', title: 'X' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts plain text with a Title header to ntfy', async () => {
    findUniqueMock.mockResolvedValue(
      enabledSettings({ channel: 'NTFY', url: 'https://ntfy.sh/my-topic' }),
    );
    await service.notifySceneChanges([
      { event: 'AVAILABLE', title: 'Scene A' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ntfy.sh/my-topic',
      expect.objectContaining({
        method: 'POST',
        body: 'Scene A',
        headers: expect.objectContaining({ Title: 'Now in your library' }),
      }),
    );
  });

  it('never throws when delivery fails during sync', async () => {
    findUniqueMock.mockResolvedValue(
      enabledSettings({ channel: 'WEBHOOK', url: 'http://hook.local' }),
    );
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(
      service.notifySceneChanges([{ event: 'AVAILABLE', title: 'X' }]),
    ).resolves.toBeUndefined();
  });

  it('still sends the other messages when one fails', async () => {
    findUniqueMock.mockResolvedValue(enabledSettings());
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, status: 204 });

    await expect(
      service.notifySceneChanges([
        { event: 'AVAILABLE', title: 'Scene A' },
        { event: 'FAILED', title: 'Scene C' },
      ]),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(second.embeds[0]).toEqual(
      expect.objectContaining({ title: 'Download failed' }),
    );
  });

  it('reports a failed test send clearly', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(
      service.sendTest({
        enabled: true,
        channel: 'DISCORD',
        url: 'https://discord.com/api/webhooks/1/abc',
        notifyDownloading: false,
        notifyAvailable: true,
        notifyFailed: true,
      }),
    ).rejects.toThrow('the server replied 404');
  });
});
