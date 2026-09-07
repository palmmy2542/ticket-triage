/**
 * HTTP-level idempotency.
 *
 * This is the outermost of three layers, and the only one that stops a retried
 * request from doing work twice:
 *
 *   1. HERE - `Idempotency-Key` on a POST. A retry replays the stored response
 *      instead of creating a second conversation and paying for a second LLM run.
 *   2. `side_effects` - UNIQUE (conversation, tool, dedup_key) plus a state
 *      machine, so one refund request is one refund however often it is asked for.
 *   3. The tool contract - mocks derive their result id from the dedup key, the
 *      way Stripe or PagerDuty behave for a repeated idempotency key.
 *
 * The row is inserted as `in_progress` BEFORE the handler runs. That ordering is
 * what makes two simultaneous retries safe: the second insert loses the unique
 * constraint and is told 409 rather than racing the first to completion.
 */
import {
  applyDecorators,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpCode,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UnprocessableEntityException,
  UseInterceptors,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from 'nestjs-pino';
import { createHash } from 'node:crypto';
import { catchError, concatMap, from, of, throwError, type Observable } from 'rxjs';

import { PrismaService } from '../db/prisma.service';

const IDEMPOTENT_STATUS = 'idempotent_status';
const UNIQUE_VIOLATION = 'P2002';

/**
 * Marks a route as retry-safe: sets its success status, records that status for
 * replays, and installs the interceptor. One decorator so the three cannot
 * drift apart.
 */
export const Idempotent = (statusCode: number) =>
  applyDecorators(
    HttpCode(statusCode),
    SetMetadata(IDEMPOTENT_STATUS, statusCode),
    UseInterceptors(IdempotencyInterceptor),
  );

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly logger: Logger,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const key = request.headers['idempotency-key'];
    // Optional by design: without a key we cannot dedup, and refusing the
    // request would break the simple `curl` path the README documents.
    if (typeof key !== 'string' || key.trim() === '') return next.handle();

    const successStatus =
      this.reflector.get<number>(IDEMPOTENT_STATUS, context.getHandler()) ?? 200;
    const route = `${request.method} ${request.routeOptions?.url ?? request.url}`;
    const requestHash = hashBody(request.body);

    try {
      await this.prisma.idempotencyKey.create({
        data: { key, route, requestHash, status: 'in_progress' },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.handleExisting({ key, route, requestHash, reply });
    }

    return next.handle().pipe(
      concatMap(async (body) => {
        await this.prisma.idempotencyKey.update({
          where: { key },
          data: { status: 'completed', statusCode: successStatus, response: body as Prisma.InputJsonValue },
        });
        return body;
      }),
      catchError((error: unknown) =>
        // Release the key so the client can legitimately retry a failed request.
        // Leaving it as `in_progress` would wedge that key forever.
        //
        // Trade-off, taken knowingly: if a handler failed *after* writing rows,
        // a retry can create a second conversation. That is currently
        // unreachable through this API - the runner converts every model and
        // tool failure into a degraded success - so the only realistic failure
        // is a database outage, where nothing was written. The alternative
        // (keep the key) turns a transient blip into a permanently dead key.
        from(
          this.prisma.idempotencyKey.delete({ where: { key } }).catch(() => undefined),
        ).pipe(concatMap(() => throwError(() => error))),
      ),
    );
  }

  private async handleExisting(input: {
    key: string;
    route: string;
    requestHash: string;
    reply: FastifyReply;
  }): Promise<Observable<unknown>> {
    const { key, route, requestHash, reply } = input;
    const existing = await this.prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });

    if (existing.route !== route || existing.requestHash !== requestHash) {
      // Same key, different request: almost always a client bug, and replaying
      // the old response would be a lie. 422 rather than 409 - the key itself
      // is the unprocessable part of the request.
      throw new UnprocessableEntityException({
        code: 'idempotency_key_reused',
        message: 'This Idempotency-Key was already used for a different request',
      });
    }

    if (existing.status === 'in_progress') {
      throw new ConflictException({
        code: 'request_in_progress',
        message: 'A request with this Idempotency-Key is still being processed',
      });
    }

    this.logger.log({ event: 'idempotency.replayed', idempotency_key: key, route });
    reply.header('idempotent-replayed', 'true').status(existing.statusCode ?? 200);
    return of(existing.response);
  }
}

function hashBody(body: unknown): string {
  // Stable across key order so a re-serialised retry still matches.
  return createHash('sha256').update(JSON.stringify(sortKeys(body) ?? null)).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}
