import { Logger } from '@nestjs/common';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogBuffer } from './log-buffer';
import { RecentLogs } from './recent-logs';
import { parseArguments, StashboardLogger } from './stashboard-logger';

function setup(
  options: ConstructorParameters<typeof StashboardLogger>[0] = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const logger = new StashboardLogger({
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    buffer: new LogBuffer(),
    recent: new RecentLogs(),
    ...options,
  });
  return { logger, out, err };
}

describe('StashboardLogger', () => {
  it('writes entries at the level and above, dropping the rest', () => {
    const { logger, out, err } = setup({ level: 'info' });
    logger.log('Started', 'Bootstrap');
    logger.debug('Details', 'Bootstrap');
    logger.verbose('More details', 'Bootstrap');
    logger.warn('Stash is slow', 'StashAdapter');
    logger.error('Sync failed', 'IndexingService');

    expect(out.join('')).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} INFO {2}\[Bootstrap\] Started\n/,
    );
    expect(out.join('')).toContain('WARN  [StashAdapter] Stash is slow');
    expect(out.join('')).not.toContain('Details');
    expect(err.join('')).toContain('ERROR [IndexingService] Sync failed');
    expect(logger.buffer.query().entries.map((e) => e.level)).toEqual([
      'error',
      'warn',
      'info',
    ]);
  });

  it('changes level while running', () => {
    const { logger, out } = setup({ level: 'info' });
    logger.debug('hidden', 'X');
    logger.setLevel('trace');
    logger.debug('shown', 'X');
    logger.verbose('traced', 'X');
    expect(out.join('')).not.toContain('hidden');
    expect(out.join('')).toContain('DEBUG [X] shown');
    expect(out.join('')).toContain('TRACE [X] traced');
  });

  it('marks fatal entries as errors labelled FATAL', () => {
    const { logger, err } = setup();
    logger.fatal('Out of memory', 'Main');
    expect(err.join('')).toContain('FATAL [Main] Out of memory');
    expect(logger.buffer.query().entries[0]).toMatchObject({
      level: 'error',
      fatal: true,
    });
  });

  it('moves Nest’s start-up chatter below info', () => {
    const { logger, out } = setup({ level: 'info' });
    logger.log('Mapped {/api/scenes, GET} route', 'RouterExplorer');
    logger.log('AppController {/api}:', 'RoutesResolver');
    logger.log('AppModule dependencies initialized', 'InstanceLoader');
    logger.log('Starting Nest application...', 'NestFactory');
    logger.log('Nest application successfully started', 'NestApplication');
    expect(out).toEqual([]);

    logger.setLevel('trace');
    logger.log('Mapped {/api/scenes, GET} route', 'RouterExplorer');
    logger.log('Starting Nest application...', 'NestFactory');
    expect(out.join('')).toContain('TRACE [RouterExplorer] Mapped');
    expect(out.join('')).toContain('DEBUG [NestFactory] Starting');
  });

  it('removes secrets before writing anywhere', () => {
    const { logger, out } = setup();
    logger.warn(
      'GET http://prowlarr/api/v1/search?apikey=abc123 failed',
      'ProwlarrAdapter',
    );
    expect(out.join('')).toContain('apikey=[redacted]');
    expect(out.join('')).not.toContain('abc123');
    expect(logger.buffer.query().entries[0].message).not.toContain('abc123');
  });

  it('keeps warnings and errors for About & health', () => {
    const { logger } = setup();
    logger.log('fine', 'X');
    logger.warn('careful', 'X');
    logger.error('Page broke (browser /home)', 'WebApp');
    expect(logger.recent.list()).toEqual([
      expect.objectContaining({ level: 'error', source: 'app' }),
      expect.objectContaining({ level: 'warn', message: 'careful' }),
    ]);
    expect(logger.buffer.query().entries[0].source).toBe('app');
  });

  it('writes JSON lines with LOG_FORMAT=json', () => {
    const { logger, out } = setup({ format: 'json' });
    logger.log('Started', 'Bootstrap');
    expect(JSON.parse(out[0])).toMatchObject({
      level: 'info',
      context: 'Bootstrap',
      message: 'Started',
    });
  });

  it('works behind Nest’s Logger', () => {
    const { logger, out, err } = setup({ level: 'trace' });
    Logger.overrideLogger(logger);
    try {
      const log = new Logger('AcquisitionService');
      log.log('Searching');
      log.debug('Found 3 releases');
      log.verbose('Release list');
      log.warn('No indexer answered');
      log.error('Grab failed', new Error('boom').stack);
      log.error(new Error('Unexpected'));
    } finally {
      Logger.overrideLogger(false);
    }
    const text = out.join('');
    expect(text).toContain('INFO  [AcquisitionService] Searching');
    expect(text).toContain('DEBUG [AcquisitionService] Found 3 releases');
    expect(text).toContain('TRACE [AcquisitionService] Release list');
    expect(text).toContain('WARN  [AcquisitionService] No indexer answered');
    const errors = logger.buffer.query({ level: 'error' }).entries;
    expect(errors[1]).toMatchObject({
      context: 'AcquisitionService',
      message: 'Grab failed',
    });
    expect(errors[1].stack).toContain('Error: boom');
    expect(errors[0]).toMatchObject({ message: 'Unexpected' });
    expect(errors[0].stack).toContain('at ');
    expect(err.join('')).toMatch(
      /ERROR \[AcquisitionService\] Grab failed\n {4}Error: boom\n {4}at /,
    );
    // The stack of an error logged on its own doesn't repeat its message.
    expect(err.join('')).toMatch(
      /ERROR \[AcquisitionService\] Unexpected\n {4}at /,
    );
  });

  it('writes log files, and stops and starts them when asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stashboard-logger-'));
    try {
      const { logger } = setup({
        console: false,
        fileDirectory: dir,
        fileEnabled: true,
      });
      expect(logger.filePath).toBe(join(dir, 'stashboard.txt'));
      logger.log('to the file', 'X');
      await logger.flush();
      logger.setFileEnabled(false);
      logger.log('not to the file', 'X');
      await logger.flush();
      expect(logger.filePath).toBeNull();

      const text = await readFile(join(dir, 'stashboard.txt'), 'utf8');
      expect(text).toMatch(/INFO {2}\[X\] to the file\n$/);
      expect(text).not.toContain('not to the file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never throws, whatever it’s given', () => {
    const { logger } = setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => {
      logger.log(circular, 'X');
      logger.log(undefined);
      logger.warn(42n);
    }).not.toThrow();
  });
});

describe('parseArguments', () => {
  it('reads Nest’s conventions', () => {
    expect(parseArguments('info', 'hello', ['Ctx'])).toEqual({
      message: 'hello',
      context: 'Ctx',
      stack: null,
    });
    expect(parseArguments('error', 'failed', ['stack here', 'Ctx'])).toEqual({
      message: 'failed',
      context: 'Ctx',
      stack: 'stack here',
    });
    expect(parseArguments('error', 'failed', [undefined, 'Ctx'])).toEqual({
      message: 'failed',
      context: 'Ctx',
      stack: null,
    });
  });

  it('adds an error passed after the message', () => {
    const error = new Error('ECONNREFUSED');
    const parsed = parseArguments('error', 'Stash unreachable', [error, 'X']);
    expect(parsed.message).toBe('Stash unreachable: ECONNREFUSED');
    expect(parsed.stack).toBe(error.stack);
    expect(parseArguments('warn', 'Retrying', [error, 'X'])).toMatchObject({
      message: 'Retrying: ECONNREFUSED',
      stack: null,
    });
  });

  it('turns objects into JSON', () => {
    expect(parseArguments('info', { a: 1 }, ['X']).message).toBe('{"a":1}');
  });
});
