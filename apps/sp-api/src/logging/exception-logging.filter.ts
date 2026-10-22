import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpServer,
  HttpStatus,
  IntrinsicException,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';

/**
 * Nest's own exception handling, answering exactly as before, except that
 * every server error (5xx) is logged once at error level with its stack and
 * the request it came from. Nest on its own logs only unexpected errors, and
 * without saying which request failed.
 */
@Catch()
export class ExceptionLoggingFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) {
      if (exception.getStatus() >= 500) {
        this.report(exception, host);
      }
      super.catch(exception, host);
      return;
    }
    this.handleUnknownError(
      exception,
      host,
      this.applicationRef ?? this.httpAdapterHost?.httpAdapter,
    );
  }

  /** Nest's answer for anything that isn't an HttpException, logged with the request. */
  handleUnknownError(
    exception: unknown,
    host: ArgumentsHost,
    applicationRef: HttpServer | undefined,
  ): void {
    const known = this.isHttpError(exception);
    const statusCode = known
      ? (exception as { statusCode: number }).statusCode
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = {
      statusCode,
      message: known
        ? (exception as { message: string }).message
        : 'Internal server error',
    };
    const response: unknown = host.getArgByIndex(1);
    if (applicationRef && !applicationRef.isHeadersSent(response)) {
      applicationRef.reply(response, body, statusCode);
    } else {
      applicationRef?.end(response);
    }
    if (!(exception instanceof IntrinsicException) && statusCode >= 500) {
      this.report(exception, host);
    }
  }

  private report(exception: unknown, host: ArgumentsHost): void {
    const request =
      host.getType() === 'http'
        ? host.switchToHttp().getRequest<Request | undefined>()
        : undefined;
    const where = request
      ? ` (${request.method} ${(request.originalUrl ?? request.url ?? '').split('?')[0]})`
      : '';
    if (exception instanceof Error) {
      this.logger.error(
        `${exception.message || exception.name}${where}`,
        exception.stack,
      );
    } else {
      this.logger.error(`${String(exception)}${where}`);
    }
  }
}
