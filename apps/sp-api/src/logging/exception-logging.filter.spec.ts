import {
  BadGatewayException,
  Controller,
  Get,
  INestApplication,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ExceptionLoggingFilter } from './exception-logging.filter';

@Controller('api/test')
class FailingController {
  @Get('crash')
  crash(): never {
    throw new Error('Cannot read properties of undefined');
  }

  @Get('bad-gateway')
  badGateway(): never {
    throw new BadGatewayException('Whisparr is down');
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('No such scene');
  }
}

describe('ExceptionLoggingFilter', () => {
  let app: INestApplication;
  const error = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FailingController],
      providers: [{ provide: APP_FILTER, useClass: ExceptionLoggingFilter }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    error.mockRestore();
  });

  beforeEach(() => error.mockClear());

  it('answers an unexpected error as Nest does, and logs it once with its stack', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/test/crash?apikey=x')
      .expect(500);
    expect(response.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      'Cannot read properties of undefined (GET /api/test/crash)',
      expect.stringContaining('at '),
    );
  });

  it('logs server errors thrown on purpose, keeping their answer', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/test/bad-gateway')
      .expect(502);
    expect(response.body).toMatchObject({ message: 'Whisparr is down' });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('leaves client errors alone', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/test/missing')
      .expect(404);
    expect(response.body).toMatchObject({
      statusCode: 404,
      message: 'No such scene',
    });
    expect(error).not.toHaveBeenCalled();
  });
});
