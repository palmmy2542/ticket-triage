import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'unprocessable_entity',
};

function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? `http_error_${status}`;
}

/**
 * Renders every error as { error: { code, message, details?, request_id } }.
 * Unknown errors become a generic 500 and are logged with the real cause;
 * their details are never leaked to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('AllExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId =
      (request.headers['x-request-id'] as string | undefined) ?? request.id ?? randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal_error';
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const bodyRecord = body as Record<string, unknown>;
        code = typeof bodyRecord.code === 'string' ? bodyRecord.code : codeForStatus(status);
        message = typeof bodyRecord.message === 'string' ? bodyRecord.message : exception.message;
        details = bodyRecord.details;
      } else {
        code = codeForStatus(status);
        message = exception.message;
      }
    } else {
      this.logger.error(
        `Unhandled exception [request_id=${requestId}]: ${
          exception instanceof Error ? exception.stack : String(exception)
        }`,
      );
    }

    response
      .header('x-request-id', requestId)
      .status(status)
      .send({ error: { code, message, details, request_id: requestId } });
  }
}
