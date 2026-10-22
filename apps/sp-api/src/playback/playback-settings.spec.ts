import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { LocalLibraryController } from './local-library.controller';
import { LocalLibraryService } from './local-library.service';
import { PlaybackFeatureGuard } from './playback-feature.guard';
import { PlaybackSettingsController } from './playback-settings.controller';
import {
  allowsFeature,
  DEFAULT_PLAYBACK_SETTINGS,
  PlaybackSettingsService,
} from './playback-settings.service';

type Row = {
  enabled: boolean;
  feedEnabled: boolean;
  previewsEnabled: boolean;
  updatedAt: Date;
};

const ALL_ON = { enabled: true, feedEnabled: true, previewsEnabled: true };

describe('Playback settings API', () => {
  let app: INestApplication;
  let saved: Row | null;
  const prisma = {
    playbackSettings: {
      findUnique: jest.fn(() => Promise.resolve(saved)),
      upsert: jest.fn(({ create }: { create: Omit<Row, 'updatedAt'> }) => {
        saved = { ...create, updatedAt: new Date('2026-10-22T10:00:00Z') };
        return Promise.resolve(saved);
      }),
    },
  };
  const library = {
    feed: jest.fn(() => Promise.resolve({ items: [], hasMore: false })),
  };

  beforeEach(async () => {
    saved = null;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [PlaybackSettingsController, LocalLibraryController],
      providers: [
        PlaybackSettingsService,
        PlaybackFeatureGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: LocalLibraryService, useValue: library },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('is all on until something is saved', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/playback/settings')
      .expect(200);
    expect(response.body).toEqual(DEFAULT_PLAYBACK_SETTINGS);
  });

  it('saves the switches and returns them', async () => {
    const body = { enabled: false, feedEnabled: true, previewsEnabled: false };
    const response = await request(app.getHttpServer())
      .put('/api/playback/settings')
      .send(body)
      .expect(200);
    expect(response.body).toEqual({
      ...body,
      updatedAt: '2026-10-22T10:00:00.000Z',
    });
    expect(prisma.playbackSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'GLOBAL' } }),
    );

    const again = await request(app.getHttpServer())
      .get('/api/playback/settings')
      .expect(200);
    expect(again.body).toMatchObject(body);
  });

  it.each([
    ['a missing switch', { enabled: true, feedEnabled: true }],
    ['a switch that is not true or false', { ...ALL_ON, enabled: 'yes' }],
    ['an unexpected field', { ...ALL_ON, autoplay: true }],
  ])('rejects %s', async (_label, body) => {
    await request(app.getHttpServer())
      .put('/api/playback/settings')
      .send(body)
      .expect(400);
    expect(prisma.playbackSettings.upsert).not.toHaveBeenCalled();
  });

  it('serves the swipe feed while it is on', async () => {
    await request(app.getHttpServer()).get('/api/local/feed').expect(200);
    expect(library.feed).toHaveBeenCalled();
  });

  it.each([
    [
      'the feed is off',
      { ...ALL_ON, feedEnabled: false },
      'The swipe feed is turned off. Turn it on in Settings → Playback.',
    ],
    [
      'playback is off',
      { ...ALL_ON, enabled: false },
      'Playback is turned off. Turn it on in Settings → Playback.',
    ],
  ])('refuses the swipe feed when %s', async (_label, body, message) => {
    await request(app.getHttpServer())
      .put('/api/playback/settings')
      .send(body)
      .expect(200);
    const response = await request(app.getHttpServer())
      .get('/api/local/feed')
      .expect(403);
    expect((response.body as { message: string }).message).toBe(message);
    expect(library.feed).not.toHaveBeenCalled();
  });

  it('leaves the rest of the library alone when playback is off', async () => {
    await request(app.getHttpServer())
      .put('/api/playback/settings')
      .send({ ...ALL_ON, enabled: false })
      .expect(200);
    const jobs = jest.fn(() => Promise.resolve([]));
    (library as Record<string, unknown>).jobs = jobs;
    await request(app.getHttpServer()).get('/api/local/jobs').expect(200);
    expect(jobs).toHaveBeenCalled();
  });
});

describe('PlaybackSettingsService', () => {
  const row = (data: Partial<Row> = {}): Row => ({
    ...ALL_ON,
    updatedAt: new Date('2026-10-22T10:00:00Z'),
    ...data,
  });

  it('reads the database once and keeps the answer', async () => {
    const prisma = {
      playbackSettings: {
        findUnique: jest.fn().mockResolvedValue(row({ enabled: false })),
      },
    };
    const service = new PlaybackSettingsService(
      prisma as unknown as PrismaService,
    );
    await expect(service.allows('playback')).resolves.toBe(false);
    await expect(service.allows('playback')).resolves.toBe(false);
    expect(prisma.playbackSettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it('logs what changed at info', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const prisma = {
      playbackSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest
          .fn()
          .mockResolvedValue(row({ enabled: false, previewsEnabled: false })),
      },
    };
    const service = new PlaybackSettingsService(
      prisma as unknown as PrismaService,
    );
    const saved = await service.update({
      enabled: false,
      feedEnabled: true,
      previewsEnabled: false,
    });
    expect(saved.enabled).toBe(false);
    expect(log).toHaveBeenCalledWith(
      'Playback settings changed: playback off, card previews off',
    );
    await expect(service.allows('preview')).resolves.toBe(false);
    log.mockRestore();
  });
});

describe('allowsFeature', () => {
  it('turns everything off with the main switch', () => {
    const off = { ...ALL_ON, enabled: false };
    expect(allowsFeature(off, 'playback')).toBe(false);
    expect(allowsFeature(off, 'feed')).toBe(false);
    expect(allowsFeature(off, 'preview')).toBe(false);
  });

  it('keeps preview clips while the feed or card previews needs them', () => {
    expect(
      allowsFeature({ ...ALL_ON, previewsEnabled: false }, 'preview'),
    ).toBe(true);
    expect(allowsFeature({ ...ALL_ON, feedEnabled: false }, 'preview')).toBe(
      true,
    );
    expect(
      allowsFeature(
        { ...ALL_ON, feedEnabled: false, previewsEnabled: false },
        'preview',
      ),
    ).toBe(false);
    expect(allowsFeature({ ...ALL_ON, feedEnabled: false }, 'feed')).toBe(
      false,
    );
    expect(allowsFeature({ ...ALL_ON, feedEnabled: false }, 'playback')).toBe(
      true,
    );
  });
});
