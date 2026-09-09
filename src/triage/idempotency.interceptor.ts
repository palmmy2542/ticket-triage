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
 *
 * Every attempt therefore ends in a terminal status - `completed` or `failed` -
 * and a retry of the same key is answered from the row, never by re-running the
 * handler. A key is never released: see `recordFailure` for why re-running a
 * failed attempt is the dangerous option here, not the safe one.
 *
 * A `failed` row is answered one of two ways, and the difference is the whole
 * point of `failureSnapshot` storing NULL rather than a placeholder: a failure
 * that produced a client-visible response is replayed verbatim, while one that
 * produced nothing is answered 409 `idempotency_key_spent`. See
 * `handleExisting`.
 */
import {
  applyDecorators,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpCode,
  HttpException,
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
        await this.settle(key, route, {
          status: 'completed',
          statusCode: successStatus,
          response: body as Prisma.InputJsonValue,
        });
        return body;
      }),
      catchError((error: unknown) =>
        from(this.recordFailure(key, route, error)).pipe(concatMap(() => throwError(() => error))),
      ),
    );
  }

  /**
   * Move a failed attempt to the TERMINAL `failed` status, carrying its status
   * code and whatever client-visible body it produced (see `failureSnapshot`),
   * so a retry of the same key is answered from that row instead of silently
   * re-running the request.
   *
   * This used to `delete` the row, on the stated premise that a handler cannot
   * fail after writing durable rows because "the runner converts every model and
   * tool failure into a degraded success". The premise was false.
   * `ConversationService.runTurnFor` commits `conversation.create`,
   * `agentTurn.create`, and every `side_effects` row (SideEffectsService writes
   * through `this.prisma`, never a transaction handle) BEFORE and OUTSIDE its
   * closing transaction - and that transaction can still fail: a lock conflict,
   * a P2024 pool-acquisition timeout, or a pool closed mid-turn by a deploy.
   *
   * Deleting the key then let the retry create a SECOND conversation, and a new
   * conversation is a fresh dedup scope for every CONVERSATION-SCOPED effect.
   * `issue_refund` is the one that hurts: its key is `<customer>:<charge>`, so
   * the same charge under a second conversation id is a second pending refund,
   * authorisable by a second operator who cannot see the first one's queue.
   * (`open_incident` is globally scoped and would still collapse to one
   * incident - it was the original example here and is no longer the danger.)
   *
   * Trade-off, taken knowingly and the opposite way round from before: a client
   * whose request failed for a purely transient reason - or on a body their own
   * validator should have caught - must mint a NEW key rather than reuse this
   * one. That is what a payment API does with a recorded error response, and a
   * burned key is far cheaper than a duplicate page or a duplicate refund scope.
   *
   * It also closes a race by construction rather than by handling it:
   * `handleExisting`'s `findUniqueOrThrow` used to raise P2025 - surfacing as a
   * generic 500 - when the winner's error path deleted the row in between.
   * Nothing deletes the row any more.
   *
   * Both halves of that argument have since been built, and this comment is
   * kept pointing at them rather than at the gap they closed:
   * `ReconcilerService.sweepIdempotencyKeys` ages a key whose request vanished
   * into a replayable 503 - so "burned forever" is now "burned until the sweep"
   * - and `purgeIdempotencyKeys` gives the table a retention window, so it no
   * longer grows without bound.
   */
  private async recordFailure(key: string, route: string, error: unknown): Promise<void> {
    const { statusCode, response } = failureSnapshot(error);

    try {
      await this.settle(key, route, { status: 'failed', statusCode, response });
      this.logger.warn({
        event: 'idempotency.failed',
        idempotency_key: key,
        route,
        status_code: statusCode,
      });
    } catch (updateError) {
      // We could not even record the failure - most likely the same database
      // trouble that caused it. The row stays `in_progress`, so this key answers
      // 409 `request_in_progress` until `ReconcilerService.sweepIdempotencyKeys`
      // ages it into a replayable 503. Logged loudly because until then nothing
      // else will notice.
      this.logger.error({
        event: 'idempotency.failure_not_recorded',
        needs_reconciliation: true,
        idempotency_key: key,
        route,
        error: (updateError as Error).message,
      });
    }
  }

  /**
   * Close the key we are holding - and only if we are still holding it.
   *
   * Conditional on `in_progress` because this write is no longer the only one:
   * `ReconcilerService.sweepIdempotencyKeys` ages a key whose request vanished
   * into a terminal 503, and a request slow enough to be swept can still come
   * back and finish afterwards.
   *
   * The late writer loses even though its answer is the more truthful one, and
   * that is the deliberate half of this. Once the sweeper's 503 has been read,
   * the client has been told to mint a new key and may already have done so; a
   * key that then flips to `completed` answers the same `Idempotency-Key` two
   * different ways depending on when it is asked. The caller who actually
   * waited still gets the true answer - it is this response, and it is in the
   * log below - so what is lost is a stored copy, not the outcome.
   */
  private async settle(
    key: string,
    route: string,
    data: {
      status: 'completed' | 'failed';
      statusCode: number;
      // `DbNull` because a failure with no client-visible body stores SQL NULL
      // rather than JSON null - see `failureSnapshot`.
      response: Prisma.InputJsonValue | typeof Prisma.DbNull;
    },
  ): Promise<void> {
    const settled = await this.prisma.idempotencyKey.updateMany({
      where: { key, status: 'in_progress' },
      data,
    });
    if (settled.count === 1) return;

    const current = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    this.logger.warn({
      event: 'idempotency.settled_elsewhere',
      idempotency_key: key,
      route,
      stored_status: current?.status,
      stored_status_code: current?.statusCode,
      discarded_status: data.status,
      discarded_status_code: data.statusCode,
      discarded_response: data.response,
    });
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

    if (existing.status === 'failed') {
      // A failed attempt is terminal on this key either way - the first attempt
      // may already have committed a conversation, a turn, and side-effect rows
      // before it failed, so re-running would duplicate them under a fresh
      // side-effect dedup scope. But the two KINDS of failure owe the client
      // different answers.
      if (existing.response === null) {
        // Nothing was recorded, so there is nothing to replay: the attempt died
        // on something transient (a P2024 pool timeout, a pool closed by a
        // deploy) that is not an HttpException, and `failureSnapshot`
        // deliberately keeps driver detail out of a replayable body.
        //
        // Replaying a bare 500 here was a trap: the retry's body was
        // byte-identical to attempt 1's and differed only by a response header
        // no standard retry library inspects, so a caller with exponential
        // backoff on 5xx hammered a permanently dead key until its budget ran
        // out and the request was never served.
        //
        // 409 with its own code instead, matching how `explainFailedClaim`
        // turns a lost claim into an HTTP answer. Chosen because:
        //  - it is a 4xx, so off-the-shelf retry logic stops rather than backs
        //    off, which is the actual behaviour change being bought here;
        //  - the request itself may well be fine - it is the KEY that is used
        //    up - which is a conflict with stored state, not `422` (that code
        //    is already taken by "this key belongs to a different request", and
        //    reusing it would make the two indistinguishable);
        //  - the message names the remedy, because minting a new key is
        //    something only the client can do.
        //
        // NOT released instead, which was the other option on the table: a
        // handler can fail after committing a conversation, a turn and its
        // side-effect rows, and a retry on a released key opens a SECOND
        // conversation - a fresh dedup scope for every conversation-scoped
        // effect, so the same charge can become two pending refunds for two
        // operators. A burned key costs the client one round trip; a refund
        // authorised twice costs the money twice.
        this.logger.warn({
          event: 'idempotency.key_spent',
          idempotency_key: key,
          route,
          status_code: existing.statusCode,
        });
        throw new ConflictException({
          code: 'idempotency_key_spent',
          message:
            'The previous attempt with this Idempotency-Key failed without a recorded result and ' +
            'cannot be retried; retry with a new Idempotency-Key',
        });
      }

      // A recorded response means the failure said something the client can act
      // on (a 400 validation error, a 404, a 422). Retrying is pointless and the
      // stored body is the original `HttpException` response verbatim, so
      // re-throwing it renders the identical error through AllExceptionsFilter -
      // the client sees the same answer it saw the first time, and learns from
      // the header that this is a replay rather than a fresh attempt.
      this.logger.log({
        event: 'idempotency.replayed_failure',
        idempotency_key: key,
        route,
        status_code: existing.statusCode,
      });
      reply.header('idempotent-replayed', 'true');
      throw new HttpException(
        existing.response as string | Record<string, unknown>,
        existing.statusCode ?? 500,
      );
    }

    this.logger.log({ event: 'idempotency.replayed', idempotency_key: key, route });
    reply.header('idempotent-replayed', 'true').status(existing.statusCode ?? 200);
    return of(existing.response);
  }
}

/**
 * What has to be stored to reproduce this failure response later.
 *
 * The `HttpException` body is kept verbatim rather than re-derived, so a replay
 * re-throws an equivalent exception and AllExceptionsFilter renders exactly what
 * it rendered the first time - including a string body or a `details` payload we
 * would otherwise have to reimplement here and keep in step with the filter.
 *
 * Anything that is NOT an HttpException records statusCode 500 and NO response
 * at all. Two reasons, and the second is the load-bearing one:
 *
 *  - A stack or a driver message must never be persisted into a body we will
 *    later replay to a client.
 *  - SQL NULL is the honest record of "this attempt produced nothing a client
 *    can act on", and it is what lets `handleExisting` tell that case apart from
 *    a real 400/404/422 without a new column to key off. It used to store the
 *    generic `{code:'internal_error'}` body the exception filter renders anyway,
 *    which is indistinguishable from a genuine recorded answer - so every retry
 *    of a pool-timed-out key got a byte-identical 500 forever.
 */
function failureSnapshot(error: unknown): {
  statusCode: number;
  response: Prisma.InputJsonValue | typeof Prisma.DbNull;
} {
  if (error instanceof HttpException) {
    return {
      statusCode: error.getStatus(),
      response: error.getResponse() as Prisma.InputJsonValue,
    };
  }
  return { statusCode: 500, response: Prisma.DbNull };
}

function hashBody(body: unknown): string {
  // Stable across key order so a re-serialised retry still matches.
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(body) ?? null))
    .digest('hex');
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
