// Before anything reads its settings: the names from before the rename.
import './legacy-env';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { AppModule } from './app.module';
import { configureApp, staticCacheControl } from './app.setup';
import { resolveBuildInfo } from './about/build-info';
import {
  resolveLoggingConfig,
  unknownEnvLogLevels,
} from './logging/log-levels';
import { appLogger } from './logging/stashboard-logger';

async function bootstrap() {
  // LOG_LEVEL, LOG_FORMAT and LOG_FILE; a level saved in Settings → Logs
  // replaces LOG_LEVEL once the database is up.
  const logging = resolveLoggingConfig();
  appLogger.configure(logging);
  await appLogger.prepareFiles();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: appLogger,
  });
  const logger = new Logger('Bootstrap');
  const unknownLevels = unknownEnvLogLevels();
  if (unknownLevels.length > 0) {
    logger.warn(
      `Ignoring unknown log level(s) ${unknownLevels.join(', ')}; using ${logging.level}.`,
    );
  }

  configureApp(app);
  // Node runs as PID 1 in the container, where SIGTERM does nothing unless
  // handled: without this, "docker stop" waits 10s and then kills the app.
  app.enableShutdownHooks();

  if (process.env.NODE_ENV === 'production') {
    const staticAssetsPath = join(
      process.cwd(),
      'apps/sp-web/dist/sp-web/browser',
    );
    const indexFilePath = join(staticAssetsPath, 'index.html');

    if (existsSync(indexFilePath)) {
      app.useStaticAssets(staticAssetsPath, {
        index: false,
        setHeaders: (res: Response, filePath: string) => {
          res.setHeader('Cache-Control', staticCacheControl(filePath));
        },
      });
      app
        .getHttpAdapter()
        .getInstance()
        .get(/^\/(?!api(?:\/|$)).*/, (req: Request, res: Response) => {
          if (extname(req.path)) {
            res.status(404).end();
            return;
          }

          res.sendFile(indexFilePath, {
            headers: { 'Cache-Control': 'no-cache' },
          });
        });
    } else {
      logger.warn(`Static frontend build not found at ${staticAssetsPath}`);
    }
  }

  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen(port, host);
  new Logger('Stashboard').log(
    `Stashboard ${resolveBuildInfo().version} listening on ${host}:${port}` +
      ` · log level ${appLogger.level}` +
      ` · log file ${appLogger.filePath ?? (appLogger.filesEnabled ? 'unavailable' : 'off')}`,
  );
}
void bootstrap();
