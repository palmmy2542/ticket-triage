/**
 * Side-effect state machine over Postgres.
 *
 *   pending_approval --approve--> executing --> succeeded | failed
 *          |                                        ^
 *          +--reject--> rejected                    |
 *   (autonomous tools skip approval and claim `executing` directly) ----+
 *
 * The properties that make retries safe:
 *
 *  1. UNIQUE (conversation_id, tool_name, dedup_key). The dedup key is derived
 *     by the server from the tool arguments, so "refund charge ch_x" is one row
 *     per conversation no matter how many times it is requested. Scoping by
 *     conversation matters: an unscoped key would let one customer's refund
 *     replay another customer's stored result.
 *
 *  2. Every transition is an atomic conditional UPDATE (`updateMany` with the
 *     expected status in the WHERE clause). Two concurrent approvals cannot both
 *     see `pending_approval` and both execute: exactly one gets count 1.
 *
 *  3. Write-ahead. The row reaches `executing` and is committed BEFORE the
 *     external call, so a crash between call and response leaves evidence to
 *     reconcile instead of a silent double-charge.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Logger } from 'nestjs-pino';

import { PrismaService } from '../db/prisma.service';
import type { SideEffectRecord, SideEffectStore, ToolContext, ToolRegistry } from '../agent/types';
import { toSideEffectResponse, type SideEffectResponse } from './dto';

const UNIQUE_VIOLATION = 'P2002';

type Row = Awaited<ReturnType<PrismaService['sideEffect']['findUniqueOrThrow']>>;

const toRecord = (row: Row): SideEffectRecord => ({
  id: row.id,
  toolName: row.toolName,
  dedupKey: row.dedupKey,
  status: row.status as SideEffectRecord['status'],
  args: row.args,
  result: row.result ?? undefined,
});

@Injectable()
export class SideEffectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
  ) {}

  /**
   * Bind the store to one agent turn. `requested_by_turn_id` is what makes the
   * audit trail answer "which decision asked for this refund".
   */
  forTurn(turnId: string): SideEffectStore {
    return {
      requestApproval: (input) => this.requestApproval({ ...input, turnId }),
      beginAutonomous: (input) => this.beginAutonomous({ ...input, turnId }),
      complete: (input) => this.complete(input),
    };
  }

  private async requestApproval(input: {
    conversationId: string;
    toolName: string;
    dedupKey: string;
    args: unknown;
    turnId: string;
  }): Promise<SideEffectRecord> {
    // `update: {}` is deliberate: if the row already exists we return it
    // untouched. Re-requesting an approval must never reset a decided one.
    const row = await this.prisma.sideEffect.upsert({
      where: {
        conversationId_toolName_dedupKey: {
          conversationId: input.conversationId,
          toolName: input.toolName,
          dedupKey: input.dedupKey,
        },
      },
      create: {
        conversationId: input.conversationId,
        toolName: input.toolName,
        dedupKey: input.dedupKey,
        status: 'pending_approval',
        args: input.args as Prisma.InputJsonValue,
        requestedByTurnId: input.turnId,
      },
      update: {},
    });

    this.log('side_effect.requested', row.id, row.status, input);
    return toRecord(row);
  }

  private async beginAutonomous(input: {
    conversationId: string;
    toolName: string;
    dedupKey: string;
    args: unknown;
    turnId: string;
  }): Promise<{ outcome: 'claimed' | 'replayed' | 'in_flight'; record: SideEffectRecord }> {
    try {
      const row = await this.prisma.sideEffect.create({
        data: {
          conversationId: input.conversationId,
          toolName: input.toolName,
          dedupKey: input.dedupKey,
          status: 'executing',
          args: input.args as Prisma.InputJsonValue,
          requestedByTurnId: input.turnId,
        },
      });
      this.log('side_effect.claimed', row.id, row.status, input);
      return { outcome: 'claimed', record: toRecord(row) };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.sideEffect.findUniqueOrThrow({
      where: {
        conversationId_toolName_dedupKey: {
          conversationId: input.conversationId,
          toolName: input.toolName,
          dedupKey: input.dedupKey,
        },
      },
    });

    if (existing.status === 'succeeded') {
      this.log('side_effect.replayed', existing.id, existing.status, input);
      return { outcome: 'replayed', record: toRecord(existing) };
    }

    if (existing.status === 'failed') {
      // A transient downstream failure should be retryable. Re-claiming is safe
      // because the tool is called with the same server-derived idempotency key,
      // so if the first attempt did land, the provider returns the same result.
      const claimed = await this.prisma.sideEffect.updateMany({
        where: { id: existing.id, status: 'failed' },
        data: { status: 'executing' },
      });
      if (claimed.count === 1) {
        return { outcome: 'claimed', record: { ...toRecord(existing), status: 'executing' } };
      }
    }

    this.log('side_effect.in_flight', existing.id, existing.status, input);
    return { outcome: 'in_flight', record: toRecord(existing) };
  }

  private async complete(input: {
    id: string;
    status: 'succeeded' | 'failed';
    result: unknown;
  }): Promise<SideEffectRecord> {
    const row = await this.prisma.sideEffect.update({
      where: { id: input.id },
      data: { status: input.status, result: input.result as Prisma.InputJsonValue },
    });
    this.logger.log({
      event: 'side_effect.transition',
      side_effect_id: row.id,
      tool: row.toolName,
      status: row.status,
    });
    return toRecord(row);
  }

  // -------------------------------------------------------------------------
  // Human decisions
  // -------------------------------------------------------------------------

  /**
   * Approve and execute a gated side effect.
   *
   * Safe to call twice, concurrently or minutes apart:
   *  - the conditional UPDATE means only one caller transitions the row
   *  - a caller that arrives after completion gets the stored result back
   *    (`replayed: true`) instead of a second execution
   */
  async approve(
    conversationId: string,
    id: string,
    registry: ToolRegistry,
    ctxFor: (row: { conversationId: string }) => Promise<ToolContext>,
  ): Promise<{ side_effect: SideEffectResponse; replayed: boolean }> {
    const claimed = await this.prisma.sideEffect.updateMany({
      where: { id, conversationId, status: 'pending_approval' },
      data: { status: 'executing' },
    });

    if (claimed.count === 0) return this.explainFailedClaim(conversationId, id);

    const row = await this.prisma.sideEffect.findUniqueOrThrow({ where: { id } });
    const tool = registry.get(row.toolName);
    if (!tool) {
      // The tool was removed while an approval was pending. Fail the row rather
      // than leaving it stuck in `executing`.
      const failed = await this.prisma.sideEffect.update({
        where: { id },
        data: {
          status: 'failed',
          result: { ok: false, error: { code: 'tool_not_registered' } } as Prisma.InputJsonValue,
        },
      });
      return { side_effect: toSideEffectResponse(failed), replayed: false };
    }

    const ctx = await ctxFor(row);
    let result: unknown;
    let status: 'succeeded' | 'failed';
    try {
      result = await tool.execute(row.args, ctx);
      status = (result as { ok?: boolean }).ok === false ? 'failed' : 'succeeded';
    } catch (error) {
      result = { ok: false, error: { code: 'downstream_unavailable', message: (error as Error).message } };
      status = 'failed';
    }

    const done = await this.prisma.sideEffect.update({
      where: { id },
      data: { status, result: result as Prisma.InputJsonValue },
    });
    this.logger.log({
      event: 'side_effect.approved',
      side_effect_id: id,
      tool: done.toolName,
      status: done.status,
    });
    return { side_effect: toSideEffectResponse(done), replayed: false };
  }

  async reject(conversationId: string, id: string): Promise<{ side_effect: SideEffectResponse }> {
    const rejected = await this.prisma.sideEffect.updateMany({
      where: { id, conversationId, status: 'pending_approval' },
      data: { status: 'rejected' },
    });

    if (rejected.count === 0) {
      const { side_effect, replayed } = await this.explainFailedClaim(conversationId, id);
      // A second reject is idempotent; anything else is a genuine conflict.
      if (side_effect.status === 'rejected') return { side_effect };
      if (replayed) {
        throw new ConflictException({
          code: 'side_effect_already_executed',
          message: 'This action was already executed and cannot be rejected',
        });
      }
      return { side_effect };
    }

    const row = await this.prisma.sideEffect.findUniqueOrThrow({ where: { id } });
    this.logger.log({ event: 'side_effect.rejected', side_effect_id: id, tool: row.toolName });
    return { side_effect: toSideEffectResponse(row) };
  }

  /** Turn a lost race into the right HTTP answer. */
  private async explainFailedClaim(
    conversationId: string,
    id: string,
  ): Promise<{ side_effect: SideEffectResponse; replayed: boolean }> {
    const row = await this.prisma.sideEffect.findUnique({ where: { id } });

    if (!row || row.conversationId !== conversationId) {
      throw new NotFoundException({
        code: 'side_effect_not_found',
        message: `No side effect ${id} on conversation ${conversationId}`,
      });
    }

    switch (row.status) {
      case 'succeeded':
      case 'failed':
        // Already done: replay the stored outcome. This is what makes a retried
        // approval safe rather than a second refund.
        return { side_effect: toSideEffectResponse(row), replayed: true };
      case 'executing':
        throw new ConflictException({
          code: 'side_effect_in_progress',
          message: 'This action is currently executing',
        });
      case 'rejected':
        return { side_effect: toSideEffectResponse(row), replayed: false };
      default:
        throw new ConflictException({
          code: 'side_effect_invalid_state',
          message: `Side effect is in state ${row.status}`,
        });
    }
  }

  async listForConversation(conversationId: string) {
    return this.prisma.sideEffect.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  private log(event: string, id: string, status: string, input: { toolName: string; dedupKey: string }) {
    this.logger.log({
      event,
      side_effect_id: id,
      tool: input.toolName,
      dedup_key: input.dedupKey,
      status,
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION
  );
}
