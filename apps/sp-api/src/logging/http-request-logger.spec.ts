import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { httpRequestLogger } from './http-request-logger';

function run(
  request: Partial<Request>,
  status: number,
  durationMs: number,
  aborted = false,
) {
  const logger = { debug: jest.fn(), warn: jest.fn(), verbose: jest.fn() };
  let clock = 1000;
  const middleware = httpRequestLogger(logger, () => clock);
  const response = Object.assign(new EventEmitter(), {
    statusCode: status,
    writableFinished: !aborted,
  });
  const next = jest.fn();
  middleware(
    { method: 'GET', ip: '192.168.1.20', ...request } as Request,
    response as unknown as Response,
    next,
  );
  expect(next).toHaveBeenCalled();
  clock += durationMs;
  if (!aborted) {
    response.emit('finish');
  }
  response.emit('close');
  return logger;
}

describe('httpRequestLogger', () => {
  it('logs each API request once at debug', () => {
    const logger = run({ originalUrl: '/api/scenes?page=2' }, 200, 42);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      'GET /api/scenes?page=2 200 42ms 192.168.1.20',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('removes secrets from the query', () => {
    const logger = run(
      { method: 'POST', originalUrl: '/api/automation/webhook?token=s3cret' },
      204,
      5,
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'POST /api/automation/webhook?token=[redacted] 204 5ms 192.168.1.20',
    );
  });

  it('warns for server errors and slow requests', () => {
    expect(
      run({ originalUrl: '/api/requests' }, 502, 10).warn,
    ).toHaveBeenCalledWith('GET /api/requests 502 10ms 192.168.1.20');
    expect(
      run({ originalUrl: '/api/discover' }, 200, 4500).warn,
    ).toHaveBeenCalledWith('GET /api/discover 200 4500ms 192.168.1.20 (slow)');
  });

  it('gives release searches longer before calling them slow', () => {
    const url = '/api/downloads/scenes/abc/releases?provider=FANSDB';
    const normal = run({ originalUrl: url }, 200, 7300);
    expect(normal.warn).not.toHaveBeenCalled();
    expect(normal.debug).toHaveBeenCalledTimes(1);
    expect(
      run({ originalUrl: '/api/requests/abc/releases' }, 200, 25_000).warn,
    ).toHaveBeenCalledWith(
      'GET /api/requests/abc/releases 200 25000ms 192.168.1.20 (slow)',
    );
  });

  it('keeps polling at trace unless it fails', () => {
    const polled = run({ originalUrl: '/api/about/health' }, 200, 30);
    expect(polled.verbose).toHaveBeenCalledTimes(1);
    expect(polled.debug).not.toHaveBeenCalled();

    const logsPage = run({ originalUrl: '/api/logs?level=info' }, 200, 3);
    expect(logsPage.verbose).toHaveBeenCalledTimes(1);

    const failed = run({ originalUrl: '/api/about/health' }, 500, 30);
    expect(failed.warn).toHaveBeenCalledTimes(1);
  });

  it('skips the web app’s own files', () => {
    const logger = run({ originalUrl: '/main-ABCDEFGH.js' }, 200, 3);
    const home = run({ originalUrl: '/home' }, 200, 3);
    for (const each of [logger, home]) {
      expect(each.debug).not.toHaveBeenCalled();
      expect(each.verbose).not.toHaveBeenCalled();
    }
  });

  it('notes requests the client gave up on', () => {
    const logger = run({ originalUrl: '/api/media/x' }, 200, 12, true);
    expect(logger.debug).toHaveBeenCalledWith(
      'GET /api/media/x aborted 12ms 192.168.1.20',
    );
  });
});
