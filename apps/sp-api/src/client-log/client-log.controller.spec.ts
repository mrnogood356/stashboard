import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import {
  ClientLogController,
  escapeLogText,
  indentLogDetail,
} from './client-log.controller';

describe('ClientLogController', () => {
  const fromClient = (ip: string) =>
    ({
      ip,
      headers: { 'x-stashboard-app': 'phone' },
    }) as unknown as Request;
  const phone = fromClient('10.0.0.5');

  afterEach(() => jest.restoreAllMocks());

  it('writes the app’s errors to the log, saying where they came from', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    new ClientLogController().log(
      {
        message: 'TypeError: x is undefined',
        detail: 'at home.ts:1\nat main.ts:2',
        page: '/home',
      },
      phone,
    );
    expect(error).toHaveBeenCalledWith(
      'TypeError: x is undefined (phone app /home)\n    at home.ts:1\n    at main.ts:2',
    );
  });

  it('escapes line breaks, so a message can’t pose as a server log entry', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    new ClientLogController().log(
      {
        message: 'oops\n[Nest] 1  - LOG [Auth] Admin logged in',
        page: '/a\r\nb',
      },
      phone,
    );
    expect(error).toHaveBeenCalledWith(
      'oops\\n[Nest] 1  - LOG [Auth] Admin logged in (phone app /a\\r\\nb)',
    );
  });

  it('stops after 30 a minute, so an error loop can’t flood the log', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const controller = new ClientLogController();
    for (let entry = 0; entry < 40; entry += 1) {
      controller.log({ message: `boom ${entry}` }, phone);
    }
    expect(error).toHaveBeenCalledTimes(30);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('limits each client on its own, so one noisy app can’t silence the rest', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const controller = new ClientLogController();
    for (let entry = 0; entry < 40; entry += 1) {
      controller.log({ message: `boom ${entry}` }, phone);
    }
    controller.log({ message: 'unlock failed' }, fromClient('10.0.0.6'));
    expect(error).toHaveBeenCalledTimes(31);
    expect(error).toHaveBeenLastCalledWith('unlock failed (phone app)');
  });

  it('lets a client log again once its minute is over', () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    try {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const controller = new ClientLogController();
      for (let entry = 0; entry < 31; entry += 1) {
        controller.log({ message: 'boom' }, phone);
      }
      jest.advanceTimersByTime(61_000);
      controller.log({ message: 'later' }, phone);
      expect(error).toHaveBeenCalledTimes(31);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('escapeLogText / indentLogDetail', () => {
  it('escapes control characters', () => {
    expect(escapeLogText('a\tb\u001bc\u2028d')).toBe('a\\tb\\u001bc\\u2028d');
  });

  it('indents every line of a detail', () => {
    expect(indentLogDetail('one\r\ntwo\rthree')).toBe(
      '    one\n    two\n    three',
    );
  });
});
