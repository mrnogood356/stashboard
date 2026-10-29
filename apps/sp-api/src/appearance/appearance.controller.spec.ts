import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { AppearanceController } from './appearance.controller';
import { AppearanceService, DEFAULT_APPEARANCE } from './appearance.service';
import {
  CUSTOM_CSS_MAX_LENGTH,
  UpdateAppearanceDto,
} from './dto/appearance.dto';

type Row = Record<string, unknown> & { updatedAt: Date };

const VALID = {
  mode: 'dark',
  lightTheme: 'catppuccin-latte',
  darkTheme: 'oled',
  accentColor: '#FF9F0A',
  radius: 'round',
  density: 'compact',
  fontScale: 'large',
  material: 'glass',
  customCss: '.app-shell { letter-spacing: 0.01em; }',
};

describe('Appearance API', () => {
  let app: INestApplication;
  let saved: Row | null;
  const prisma = {
    appearanceSettings: {
      findUnique: jest.fn(() => Promise.resolve(saved)),
      upsert: jest.fn(({ create }: { create: Record<string, unknown> }) => {
        saved = { ...create, updatedAt: new Date('2026-10-22T10:00:00Z') };
        return Promise.resolve(saved);
      }),
      deleteMany: jest.fn(() => {
        saved = null;
        return Promise.resolve({ count: 1 });
      }),
    },
  };

  beforeEach(async () => {
    saved = null;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AppearanceController],
      providers: [
        AppearanceService,
        { provide: PrismaService, useValue: prisma },
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

  it('returns the defaults until something is saved', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/appearance')
      .expect(200);
    expect(response.body).toEqual(DEFAULT_APPEARANCE);
  });

  it('saves the appearance and returns it, lower-casing the accent', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/appearance')
      .send(VALID)
      .expect(200);
    expect(response.body).toEqual({
      ...VALID,
      accentColor: '#ff9f0a',
      updatedAt: '2026-10-22T10:00:00.000Z',
    });
    expect(prisma.appearanceSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'GLOBAL' } }),
    );

    const again = await request(app.getHttpServer())
      .get('/api/appearance')
      .expect(200);
    expect(again.body).toMatchObject({ darkTheme: 'oled', mode: 'dark' });
  });

  it('accepts a null accent and no custom CSS', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/appearance')
      .send({ ...VALID, accentColor: null, customCss: undefined })
      .expect(200);
    expect(response.body).toMatchObject({ accentColor: null, customCss: '' });
  });

  it.each([
    ['an unknown mode', { mode: 'sepia' }],
    ['a dark theme in the light slot', { lightTheme: 'oled' }],
    ['a light theme in the dark slot', { darkTheme: 'light' }],
    ['a named colour', { accentColor: 'red' }],
    ['a short hex colour', { accentColor: '#f00' }],
    ['an unknown radius', { radius: 'pill' }],
    ['an unknown density', { density: 'cozy' }],
    ['an unknown font scale', { fontScale: 'huge' }],
    ['an unknown material', { material: 'chrome' }],
    ['custom CSS that is too long', { customCss: 'a'.repeat(20_001) }],
    ['custom CSS that is not text', { customCss: { evil: true } }],
    ['an unexpected field', { isAdmin: true }],
  ])('rejects %s', async (_label, patch) => {
    await request(app.getHttpServer())
      .put('/api/appearance')
      .send({ ...VALID, ...patch })
      .expect(400);
    expect(prisma.appearanceSettings.upsert).not.toHaveBeenCalled();
  });

  it('rejects a body with a missing field', async () => {
    const { mode: _omit, ...rest } = VALID;
    void _omit;
    await request(app.getHttpServer())
      .put('/api/appearance')
      .send(rest)
      .expect(400);
  });

  it('resets to the defaults', async () => {
    saved = { ...VALID, updatedAt: new Date() };
    const response = await request(app.getHttpServer())
      .delete('/api/appearance')
      .expect(200);
    expect(response.body).toEqual(DEFAULT_APPEARANCE);
    expect(prisma.appearanceSettings.deleteMany).toHaveBeenCalled();
  });
});

describe('AppearanceService', () => {
  it('falls back to the defaults for values that are no longer known', async () => {
    const prisma = {
      appearanceSettings: {
        findUnique: jest.fn().mockResolvedValue({
          ...VALID,
          mode: 'retro',
          lightTheme: 'removed-theme',
          darkTheme: 'removed-theme',
          accentColor: 'not-a-colour',
          radius: '??',
          density: '??',
          fontScale: '??',
          material: '??',
          updatedAt: new Date('2026-10-22T10:00:00Z'),
        }),
      },
    };
    const service = new AppearanceService(prisma as unknown as PrismaService);
    await expect(service.get()).resolves.toEqual({
      ...DEFAULT_APPEARANCE,
      customCss: VALID.customCss,
      updatedAt: '2026-10-22T10:00:00.000Z',
    });
  });
});

describe('AppearanceService.update', () => {
  it('keeps the saved material when an older client leaves it out', async () => {
    const upsert = jest.fn(
      ({ create }: { create: Record<string, unknown> }) => ({
        material: 'glass',
        ...create,
        updatedAt: new Date('2026-10-22T10:00:00Z'),
      }),
    );
    const service = new AppearanceService({
      appearanceSettings: { upsert },
    } as unknown as PrismaService);
    const { material: _omit, ...older } = VALID;
    void _omit;

    const saved = await service.update(older as UpdateAppearanceDto);

    const [{ update }] = upsert.mock.calls[0] as unknown as [
      { update: Record<string, unknown> },
    ];
    expect(update).not.toHaveProperty('material');
    expect(saved.material).toBe('glass');
  });
});

describe('UpdateAppearanceDto', () => {
  const errorsFor = (body: Record<string, unknown>) =>
    validateSync(plainToInstance(UpdateAppearanceDto, body)).map(
      (error) => error.property,
    );

  it('accepts a full valid body', () => {
    expect(errorsFor(VALID)).toEqual([]);
  });

  it('caps custom CSS at the documented length', () => {
    expect(
      errorsFor({ ...VALID, customCss: 'a'.repeat(CUSTOM_CSS_MAX_LENGTH) }),
    ).toEqual([]);
    expect(
      errorsFor({ ...VALID, customCss: 'a'.repeat(CUSTOM_CSS_MAX_LENGTH + 1) }),
    ).toEqual(['customCss']);
  });

  it('names each invalid field', () => {
    expect(
      errorsFor({
        ...VALID,
        mode: 'x',
        accentColor: '#12345g',
        radius: 'x',
      }).sort(),
    ).toEqual(['accentColor', 'mode', 'radius']);
  });
});
