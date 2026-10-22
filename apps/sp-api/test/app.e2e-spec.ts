import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Boots the real app against a real, migrated Postgres (DATABASE_URL) and
 * drives it over HTTP: routing, the auth guard, cookies and request validation
 * are all the production ones. It empties every table first, so it refuses
 * to run unless the database is one of DISPOSABLE_DATABASES.
 */
describe('Stashboard API (e2e)', () => {
  let app: NestExpressApplication;
  let server: App;

  const admin = { username: 'admin', password: 'correct horse battery' };

  beforeAll(async () => {
    assertDisposableDatabase(process.env.DATABASE_URL);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    await resetDatabase(app.get(PrismaService));
  });

  afterAll(async () => {
    await app?.close();
  });

  function sessionCookie(response: request.Response): string {
    const cookies = ([] as string[]).concat(
      response.headers['set-cookie'] ?? [],
    );
    const session = cookies.find((cookie) =>
      cookie.startsWith('stashboard_session='),
    );
    expect(session).toBeDefined();
    return session!.split(';')[0];
  }

  it('serves the health status without signing in', async () => {
    await request(server).get('/api/v1/status').expect(200);
  });

  it('asks for the first admin account before anything else', async () => {
    const response = await request(server).get('/api/auth/status').expect(200);
    expect(response.body).toMatchObject({
      bootstrapRequired: true,
      authenticated: false,
    });
  });

  it('refuses protected routes without a session', async () => {
    await request(server).get('/api/setup/status').expect(401);
    await request(server).get('/api/studios').expect(401);
  });

  it('validates the bootstrap request body', async () => {
    await request(server)
      .post('/api/auth/bootstrap')
      .send({ username: 'admin', password: 'too short' })
      .expect(400);
    await request(server)
      .post('/api/auth/bootstrap')
      .send({ ...admin, isAdmin: true })
      .expect(400);
    await request(server).post('/api/auth/bootstrap').send({}).expect(400);
  });

  it('creates the admin once, signs them in, and then closes bootstrap', async () => {
    const created = await request(server)
      .post('/api/auth/bootstrap')
      .send(admin)
      .expect(201);
    expect(created.body).toMatchObject({
      authenticated: true,
      username: 'admin',
    });
    const cookie = sessionCookie(created);

    await request(server)
      .get('/api/setup/status')
      .set('Cookie', cookie)
      .expect(200);

    await request(server)
      .post('/api/auth/bootstrap')
      .send({ username: 'intruder', password: 'another long password' })
      .expect(409);
  });

  it('rejects a wrong password and a tampered session cookie', async () => {
    await request(server)
      .post('/api/auth/login')
      .send({ username: admin.username, password: 'wrong password!' })
      .expect(401);

    const login = await request(server)
      .post('/api/auth/login')
      .send(admin)
      .expect(201);
    const cookie = sessionCookie(login);
    const [name, value] = cookie.split('=');
    const sessionId = value.slice(0, value.lastIndexOf('.'));

    await request(server)
      .get('/api/setup/status')
      .set('Cookie', `${name}=${sessionId}.forged-signature`)
      .expect(401);
    await request(server)
      .get('/api/setup/status')
      .set('Cookie', `${name}=${sessionId}`)
      .expect(401);
  });

  it('validates query parameters before reaching the handler', async () => {
    const login = await request(server)
      .post('/api/auth/login')
      .send(admin)
      .expect(201);
    const cookie = sessionCookie(login);

    await request(server)
      .get('/api/studios?favoritesOnly=maybe')
      .set('Cookie', cookie)
      .expect(400);
    await request(server)
      .get('/api/studios?sort=nonsense')
      .set('Cookie', cookie)
      .expect(400);
    await request(server)
      .get('/api/studios?unexpected=1')
      .set('Cookie', cookie)
      .expect(400);
  });

  it('serves Settings → Logs to the admin only, and saves the level', async () => {
    await request(server).get('/api/logs').expect(401);
    await request(server).get('/api/logs/settings').expect(401);
    await request(server).get('/api/logs/files/stashboard.txt').expect(401);

    const cookie = sessionCookie(
      await request(server).post('/api/auth/login').send(admin).expect(201),
    );
    const logs = await request(server)
      .get('/api/logs?level=warn&limit=50')
      .set('Cookie', cookie)
      .expect(200);
    expect(logs.body).toMatchObject({ entries: expect.any(Array) });
    await request(server)
      .get('/api/logs?level=nonsense')
      .set('Cookie', cookie)
      .expect(400);
    await request(server)
      .get('/api/logs/files/..%2F..%2Fetc%2Fpasswd')
      .set('Cookie', cookie)
      .expect(400);

    const before = await request(server)
      .get('/api/logs/settings')
      .set('Cookie', cookie)
      .expect(200);
    expect(before.body).toMatchObject({ saved: false });

    await request(server)
      .put('/api/logs/settings')
      .set('Cookie', cookie)
      .send({ level: 'debug', fileEnabled: false })
      .expect(200);
    const after = await request(server)
      .get('/api/logs/settings')
      .set('Cookie', cookie)
      .expect(200);
    expect(after.body).toMatchObject({
      level: 'debug',
      fileEnabled: false,
      saved: true,
    });
  });

  it('serves Settings → Appearance to the admin only, and saves it', async () => {
    await request(server).get('/api/appearance').expect(401);
    await request(server).put('/api/appearance').send({}).expect(401);

    const cookie = sessionCookie(
      await request(server).post('/api/auth/login').send(admin).expect(201),
    );
    const before = await request(server)
      .get('/api/appearance')
      .set('Cookie', cookie)
      .expect(200);
    expect(before.body).toMatchObject({ mode: 'system', updatedAt: null });

    const body = {
      mode: 'dark',
      lightTheme: 'light',
      darkTheme: 'oled',
      accentColor: '#ff9f0a',
      radius: 'round',
      density: 'compact',
      fontScale: 'large',
      customCss: '.x { color: red; }',
    };
    await request(server)
      .put('/api/appearance')
      .set('Cookie', cookie)
      .send({ ...body, darkTheme: 'light' })
      .expect(400);
    await request(server)
      .put('/api/appearance')
      .set('Cookie', cookie)
      .send(body)
      .expect(200);
    const after = await request(server)
      .get('/api/appearance')
      .set('Cookie', cookie)
      .expect(200);
    expect(after.body).toMatchObject({
      ...body,
      updatedAt: expect.any(String),
    });

    await request(server)
      .delete('/api/appearance')
      .set('Cookie', cookie)
      .expect(200);
    const reset = await request(server)
      .get('/api/appearance')
      .set('Cookie', cookie)
      .expect(200);
    expect(reset.body).toMatchObject({ darkTheme: 'dark', updatedAt: null });
  });

  it('saves Settings → Playback and refuses playback while it is off', async () => {
    await request(server).get('/api/playback/settings').expect(401);
    const cookie = sessionCookie(
      await request(server).post('/api/auth/login').send(admin).expect(201),
    );
    const before = await request(server)
      .get('/api/playback/settings')
      .set('Cookie', cookie)
      .expect(200);
    expect(before.body).toEqual({
      enabled: true,
      feedEnabled: true,
      previewsEnabled: true,
      updatedAt: null,
    });

    await request(server)
      .put('/api/playback/settings')
      .set('Cookie', cookie)
      .send({ enabled: 'no', feedEnabled: true, previewsEnabled: true })
      .expect(400);
    await request(server)
      .put('/api/playback/settings')
      .set('Cookie', cookie)
      .send({ enabled: false, feedEnabled: true, previewsEnabled: true })
      .expect(200);

    // The public stream route refuses before even looking at the token.
    const stream = await request(server)
      .get('/api/playback/stream/any-token/scene/1/stream')
      .expect(403);
    expect((stream.body as { message: string }).message).toContain(
      'Playback is turned off',
    );
    await request(server)
      .get('/api/local/feed')
      .set('Cookie', cookie)
      .expect(403);

    await request(server)
      .put('/api/playback/settings')
      .set('Cookie', cookie)
      .send({ enabled: true, feedEnabled: true, previewsEnabled: true })
      .expect(200);
    // On again: a bad token is the only reason left to refuse.
    const again = await request(server)
      .get('/api/playback/stream/any-token/scene/1/stream')
      .expect(403);
    expect((again.body as { message: string }).message).toContain('expired');
  });

  it('saves the hidden-content list and validates it', async () => {
    await request(server).get('/api/hidden-content/settings').expect(401);
    await request(server)
      .post('/api/hidden-content/hide')
      .send({ kind: 'tag', id: 't', name: 'T' })
      .expect(401);
    const cookie = sessionCookie(
      await request(server).post('/api/auth/login').send(admin).expect(201),
    );

    const empty = await request(server)
      .get('/api/hidden-content/settings')
      .set('Cookie', cookie)
      .expect(200);
    expect(empty.body).toEqual({
      words: [],
      tags: [],
      studios: [],
      performers: [],
    });

    const saved = await request(server)
      .put('/api/hidden-content/settings')
      .set('Cookie', cookie)
      .send({
        words: ['Trans, transgender'],
        tags: [{ id: 'tag-1', name: 'Trans Woman' }],
        studios: [],
      })
      .expect(200);
    expect(saved.body).toEqual({
      words: ['trans', 'transgender'],
      tags: [{ id: 'tag-1', name: 'Trans Woman' }],
      studios: [],
      performers: [],
    });

    const reloaded = await request(server)
      .get('/api/hidden-content/settings')
      .set('Cookie', cookie)
      .expect(200);
    expect(reloaded.body).toEqual(saved.body);

    const hidden = await request(server)
      .post('/api/hidden-content/hide')
      .set('Cookie', cookie)
      .send({ kind: 'performer', id: 'p-1', name: 'Jane Doe' })
      .expect(200);
    expect(hidden.body.performers).toEqual([{ id: 'p-1', name: 'Jane Doe' }]);
    expect(hidden.body.words).toEqual(['trans', 'transgender']);
    const unhidden = await request(server)
      .post('/api/hidden-content/unhide')
      .set('Cookie', cookie)
      .send({ kind: 'performer', id: 'p-1' })
      .expect(200);
    expect(unhidden.body.performers).toEqual([]);

    await request(server)
      .put('/api/hidden-content/settings')
      .set('Cookie', cookie)
      .send({ words: ['x'], tags: [{ name: 'no id' }], studios: [] })
      .expect(400);
    await request(server)
      .put('/api/hidden-content/settings')
      .set('Cookie', cookie)
      .send({ words: 'trans', tags: [], studios: [] })
      .expect(400);
  });

  it('answers the already-have check softly when nothing is set up', async () => {
    await request(server).get('/api/requests/some-scene/owned').expect(401);
    const cookie = sessionCookie(
      await request(server).post('/api/auth/login').send(admin).expect(201),
    );

    const response = await request(server)
      .get('/api/requests/some-scene/owned?provider=stashdb')
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body).toEqual({ copies: [] });

    await request(server)
      .get('/api/requests/some-scene/owned?provider=nonsense')
      .set('Cookie', cookie)
      .expect(400);
    await request(server)
      .get('/api/scenes?showHidden=maybe')
      .set('Cookie', cookie)
      .expect(400);
  });

  it('ends the session on logout', async () => {
    const login = await request(server)
      .post('/api/auth/login')
      .send(admin)
      .expect(201);
    const cookie = sessionCookie(login);

    await request(server)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .expect(201);
    await request(server)
      .get('/api/setup/status')
      .set('Cookie', cookie)
      .expect(401);
  });

  it('invalidates other sessions when the password changes', async () => {
    const first = sessionCookie(
      await request(server).post('/api/auth/login').send(admin).expect(201),
    );
    const second = sessionCookie(
      await request(server).post('/api/auth/login').send(admin).expect(201),
    );

    await request(server)
      .post('/api/auth/change-password')
      .set('Cookie', first)
      .send({ currentPassword: admin.password, newPassword: 'short' })
      .expect(400);
    await request(server)
      .post('/api/auth/change-password')
      .set('Cookie', first)
      .send({
        currentPassword: admin.password,
        newPassword: 'a brand new long password',
      })
      .expect((response) => {
        expect(response.status).toBeLessThan(300);
      });

    await request(server)
      .get('/api/setup/status')
      .set('Cookie', second)
      .expect(401);
    await request(server).post('/api/auth/login').send(admin).expect(401);
  });
});

/** The only database names these tests may erase. */
const DISPOSABLE_DATABASES = ['sp_e2e', 'sp_test', 'stashboard_test'];

function assertDisposableDatabase(databaseUrl: string | undefined): void {
  const name = databaseUrl
    ? decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
    : '';
  if (!DISPOSABLE_DATABASES.includes(name)) {
    throw new Error(
      `Refusing to run end-to-end tests against database "${name}": they erase it. Point DATABASE_URL at a database named ${DISPOSABLE_DATABASES.join(', ')}.`,
    );
  }
}

async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) {
    return;
  }
  const list = tables.map(({ tablename }) => `"${tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
