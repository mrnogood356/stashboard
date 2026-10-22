import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { LogBuffer } from '../logging/log-buffer';
import { RecentLogs } from '../logging/recent-logs';
import { StashboardLogger } from '../logging/stashboard-logger';
import { PrismaService } from '../prisma/prisma.service';
import { LogsController } from './logs.controller';
import { LogsService } from './logs.service';

describe('LogsController', () => {
  let app: INestApplication;
  let dir: string;
  let logger: StashboardLogger;
  let service: LogsService;
  let saved: { key: string; level: string; fileEnabled: boolean } | null;
  const prisma = {
    logSettings: {
      findUnique: jest.fn(() => Promise.resolve(saved)),
      upsert: jest.fn(
        ({ create }: { create: { level: string; fileEnabled: boolean } }) => {
          saved = { key: 'GLOBAL', ...create };
          return Promise.resolve(saved);
        },
      ),
    },
  };

  beforeEach(async () => {
    saved = null;
    dir = await mkdtemp(join(tmpdir(), 'stashboard-logs-api-'));
    logger = new StashboardLogger({
      console: false,
      level: 'info',
      buffer: new LogBuffer(),
      recent: new RecentLogs(),
      fileDirectory: dir,
      fileEnabled: true,
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [LogsController],
      providers: [LogsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(LogsService);
    service.logger = logger;
    service.env = { LOG_LEVEL: 'debug' };
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
    await rm(dir, { recursive: true, force: true });
  });

  it('lists entries newest first, filtered by minimum level, context and text', async () => {
    logger.log('Synced 3 scenes', 'IndexingService');
    logger.warn('Stash is slow', 'StashAdapter');
    logger.error('Sync failed', 'IndexingService');

    const all = await request(app.getHttpServer()).get('/api/logs').expect(200);
    expect(all.body).toMatchObject({
      level: 'info',
      capacity: 5000,
      hasMore: false,
    });
    expect(all.body.entries.map((e: { message: string }) => e.message)).toEqual(
      ['Sync failed', 'Stash is slow', 'Synced 3 scenes'],
    );

    const warn = await request(app.getHttpServer())
      .get('/api/logs?level=warn&context=IndexingService')
      .expect(200);
    expect(warn.body.entries).toHaveLength(1);

    const search = await request(app.getHttpServer())
      .get('/api/logs?q=slow&limit=10')
      .expect(200);
    expect(search.body.entries[0].message).toBe('Stash is slow');

    const older = await request(app.getHttpServer())
      .get(`/api/logs?limit=1&before=${all.body.entries[0].id}`)
      .expect(200);
    expect(older.body.entries[0].message).toBe('Stash is slow');
    expect(older.body.hasMore).toBe(true);
  });

  it('rejects bad queries', async () => {
    await request(app.getHttpServer()).get('/api/logs?level=loud').expect(400);
    await request(app.getHttpServer()).get('/api/logs?limit=0').expect(400);
    await request(app.getHttpServer()).get('/api/logs?other=1').expect(400);
  });

  it('lists contexts and clears the buffer', async () => {
    logger.log('a', 'Zeta');
    logger.log('b', 'Alpha');
    const contexts = await request(app.getHttpServer())
      .get('/api/logs/contexts')
      .expect(200);
    expect(contexts.body).toEqual(['Alpha', 'Zeta']);

    await request(app.getHttpServer()).delete('/api/logs').expect(204);
    // Clearing is itself logged.
    expect(logger.buffer.query().entries.map((e) => e.message)).not.toContain(
      'a',
    );
  });

  it('lists and downloads log files', async () => {
    logger.log('in the file', 'X');
    await writeFile(join(dir, 'stashboard.0.txt'), 'older\n');

    const files = await request(app.getHttpServer())
      .get('/api/logs/files')
      .expect(200);
    expect(files.body).toMatchObject({ enabled: true, directory: dir });
    expect(files.body.files.map((f: { name: string }) => f.name)).toEqual([
      'stashboard.txt',
      'stashboard.0.txt',
    ]);

    const download = await request(app.getHttpServer())
      .get('/api/logs/files/stashboard.txt')
      .expect(200);
    expect(download.headers['content-disposition']).toBe(
      'attachment; filename="stashboard.txt"',
    );
    expect(download.headers['content-type']).toContain('text/plain');
    expect(download.text).toContain('in the file');

    await request(app.getHttpServer())
      .get('/api/logs/files/stashboard.3.txt')
      .expect(404);
  });

  it('refuses anything but a log file name, so no other file can be read', async () => {
    await writeFile(join(dir, 'secret.txt'), 'nope');
    for (const name of [
      '..%2F..%2Fetc%2Fpasswd',
      '..%2Fsecret.txt',
      'secret.txt',
      'stashboard.txt%00.png',
      '%2Fetc%2Fpasswd',
      '..',
    ]) {
      const response = await request(app.getHttpServer()).get(
        `/api/logs/files/${name}`,
      );
      expect([400, 404]).toContain(response.status);
      expect(response.text).not.toContain('nope');
      expect(response.text).not.toContain('root:');
    }
    await request(app.getHttpServer())
      .get('/api/logs/files/..%2Fsecret.txt')
      .expect(400);
    await expect(service.filePath('../stashboard.txt')).rejects.toThrow(
      'Not a log file name.',
    );
  });

  it('reads and saves the level, applying it at once', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/logs/settings')
      .expect(200);
    expect(before.body).toEqual({
      level: 'info',
      fileEnabled: true,
      saved: false,
      envLevel: 'debug',
      fileDirectory: dir,
      fileError: null,
    });

    const after = await request(app.getHttpServer())
      .put('/api/logs/settings')
      .send({ level: 'trace', fileEnabled: false })
      .expect(200);
    expect(after.body).toMatchObject({
      level: 'trace',
      fileEnabled: false,
      saved: true,
    });
    expect(logger.level).toBe('trace');
    expect(logger.filesEnabled).toBe(false);
    expect(prisma.logSettings.upsert).toHaveBeenCalled();

    await request(app.getHttpServer())
      .put('/api/logs/settings')
      .send({ level: 'chatty', fileEnabled: true })
      .expect(400);
    await request(app.getHttpServer())
      .put('/api/logs/settings')
      .send({ level: 'info', fileEnabled: true, extra: 1 })
      .expect(400);
  });

  it('applies the saved level on start, over LOG_LEVEL', async () => {
    saved = { key: 'GLOBAL', level: 'warn', fileEnabled: false };
    await service.onModuleInit();
    expect(logger.level).toBe('warn');
    expect(logger.filesEnabled).toBe(false);
  });

  it('keeps LOG_LEVEL when the saved settings can’t be read', async () => {
    prisma.logSettings.findUnique.mockImplementationOnce(() =>
      Promise.reject(new Error('relation does not exist')),
    );
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(logger.level).toBe('info');
  });
});
