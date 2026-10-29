import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { HiddenContentController } from './hidden-content.controller';
import { HiddenContentService } from './hidden-content.service';

describe('Hidden content API', () => {
  let app: INestApplication;
  let saved: Record<string, unknown> | null;
  const prisma = {
    hiddenContentSettings: {
      findUnique: jest.fn(() => Promise.resolve(saved)),
      upsert: jest.fn(({ create }: { create: Record<string, unknown> }) => {
        saved = { ...create };
        return Promise.resolve(saved);
      }),
    },
  };

  beforeEach(async () => {
    saved = null;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [HiddenContentController],
      providers: [
        HiddenContentService,
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

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

  it('starts empty and saves the whole list', async () => {
    await request(server())
      .get('/api/hidden-content/settings')
      .expect(200)
      .expect({
        words: [],
        tags: [],
        studios: [],
        performers: [],
        hideOwned: false,
      });

    const response = await request(server())
      .put('/api/hidden-content/settings')
      .send({
        words: ['Trans, transgender'],
        tags: [{ id: 'tag-1', name: ' Trans Woman ' }],
        studios: [],
        performers: [{ id: 'p-1', name: 'Jane' }],
        hideOwned: true,
      })
      .expect(200);

    expect(response.body).toEqual({
      words: ['trans', 'transgender'],
      tags: [{ id: 'tag-1', name: 'Trans Woman' }],
      studios: [],
      performers: [{ id: 'p-1', name: 'Jane' }],
      hideOwned: true,
    });
  });

  it.each([
    ['words not a list', { words: 'trans', tags: [], studios: [] }],
    ['a tag with no id', { words: [], tags: [{ name: 'x' }], studios: [] }],
    [
      'a studio with a blank name',
      { words: [], tags: [], studios: [{ id: 's', name: '   ' }] },
    ],
    ['studios missing', { words: [], tags: [] }],
    [
      'too many words',
      {
        words: Array.from({ length: 101 }, (_, i) => `w${i}`),
        tags: [],
        studios: [],
      },
    ],
    ['an unknown field', { words: [], tags: [], studios: [], extra: true }],
  ])('turns away %s', async (_label, body) => {
    await request(server())
      .put('/api/hidden-content/settings')
      .send(body)
      .expect(400);
    expect(prisma.hiddenContentSettings.upsert).not.toHaveBeenCalled();
  });

  it('hides and unhides one studio', async () => {
    const hidden = await request(server())
      .post('/api/hidden-content/hide')
      .send({ kind: 'studio', id: 'studio-1', name: 'Some Studio' })
      .expect(200);
    expect(hidden.body.studios).toEqual([
      { id: 'studio-1', name: 'Some Studio' },
    ]);

    const unhidden = await request(server())
      .post('/api/hidden-content/unhide')
      .send({ kind: 'studio', id: 'studio-1' })
      .expect(200);
    expect(unhidden.body.studios).toEqual([]);
  });

  it('turns away an unknown kind or a missing name', async () => {
    await request(server())
      .post('/api/hidden-content/hide')
      .send({ kind: 'scene', id: 'x', name: 'X' })
      .expect(400);
    await request(server())
      .post('/api/hidden-content/hide')
      .send({ kind: 'tag', id: 'x' })
      .expect(400);
    await request(server())
      .post('/api/hidden-content/unhide')
      .send({ kind: 'tag' })
      .expect(400);
  });
});
