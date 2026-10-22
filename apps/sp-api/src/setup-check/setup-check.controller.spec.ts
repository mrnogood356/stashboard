import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import {
  SetupCheckController,
  requestBoundOrigin,
} from './setup-check.controller';
import type { SetupCheckService } from './setup-check.service';

describe('SetupCheckController', () => {
  const request = (headers: Record<string, string>) =>
    ({ headers }) as unknown as Request;

  it('passes the origin on when it is where the request was sent', async () => {
    const fix = jest.fn().mockResolvedValue({ ok: true });
    const controller = new SetupCheckController({
      fix,
    } as unknown as SetupCheckService);

    await controller.fix(
      'whisparr-webhook',
      { origin: 'http://192.168.1.5:3000' },
      request({
        origin: 'http://192.168.1.5:3000',
        host: '192.168.1.5:3000',
      }),
    );

    expect(fix).toHaveBeenCalledWith(
      'whisparr-webhook',
      'http://192.168.1.5:3000',
    );
  });

  it('refuses an origin other than the one the request came from', () => {
    const fix = jest.fn();
    const controller = new SetupCheckController({
      fix,
    } as unknown as SetupCheckService);

    expect(() =>
      controller.fix(
        'whisparr-webhook',
        { origin: 'https://attacker.example' },
        request({
          origin: 'http://192.168.1.5:3000',
          host: '192.168.1.5:3000',
        }),
      ),
    ).toThrow(BadRequestException);
    expect(fix).not.toHaveBeenCalled();
  });

  it('checks against the Host header when there is no Origin header', () => {
    expect(
      requestBoundOrigin(
        'https://stashboard.lan',
        request({ host: 'Stashboard.lan' }),
      ),
    ).toBe('https://stashboard.lan');
    expect(() =>
      requestBoundOrigin(
        'https://evil.example',
        request({ host: 'stashboard.lan' }),
      ),
    ).toThrow(BadRequestException);
  });

  it('refuses an origin that isn’t a URL, and passes no origin through', () => {
    expect(() =>
      requestBoundOrigin('not a url', request({ host: 'stashboard.lan' })),
    ).toThrow(BadRequestException);
    expect(requestBoundOrigin(undefined, request({}))).toBeNull();
  });
});
