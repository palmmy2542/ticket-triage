/**
 * One operator/customer turn, start to finish.
 *
 * Ordering is the whole design here:
 *
 *   1. persist the ticket and its messages, and COMMIT
 *   2. open an `agent_turns` row in status `running`, and COMMIT
 *   3. run the agent (seconds; LLM + tools)
 *   4. persist the decision, tool calls, and the agent's reply
 *
 * Two reasons it is not one big transaction:
 *
 *  - A ticket must never be lost. If the model provider is down or the process
 *    is killed mid-turn, steps 1-2 are already durable: the conversation exists
 *    and there is a `running` turn to reconcile, instead of a rolled-back
 *    request and a customer with no ticket.
 *  - Holding a Postgres transaction open across a multi-second network call
 *    pins a pool connection per in-flight ticket. That is how a service with a
 *    healthy database still stops serving traffic under load.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Logger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

import { PROMPT_VERSION } from '../agent/prompt';
import { runTurn } from '../agent/runner';
import { CustomerProfileSchema, DecisionSchema, type Decision } from '../agent/schema';
import type {
  ConversationMessage,
  CustomerProfile,
  LlmClient,
  ToolContext,
  ToolRegistry,
} from '../agent/types';
import { env } from '../config/env';
import { PrismaService } from '../db/prisma.service';
import { LLM_CLIENT, TOOL_REGISTRY } from './agent.providers';
import { toAgentLogger } from './agent-logger';
import {
  toSideEffectResponse,
  type IngestTicketBody,
  type PostMessageBody,
  type TurnResponse,
} from './dto';
import { SideEffectsService } from './side-effects.service';

@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sideEffects: SideEffectsService,
    private readonly logger: Logger,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry,
  ) {}

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async ingestTicket(body: IngestTicketBody): Promise<TurnResponse> {
    const conversation = await this.prisma.conversation.create({
      data: {
        customer: body.customer as Prisma.InputJsonValue,
        status: 'open',
        messages: {
          create: body.messages.map((message, index) => ({
            seq: index + 1,
            role: 'customer',
            content: message.text,
            meta: { at: message.at } as Prisma.InputJsonValue,
          })),
        },
      },
    });

    this.logger.log({
      event: 'ticket.ingested',
      conversation_id: conversation.id,
      customer_id: body.customer.id,
      plan: body.customer.plan,
      message_count: body.messages.length,
    });

    return this.runTurnFor(conversation.id);
  }

  async addMessage(conversationId: string, body: PostMessageBody): Promise<TurnResponse> {
    await this.loadConversationOrThrow(conversationId);

    await this.prisma.$transaction(async (tx) => {
      // Lock the conversation row so concurrent appends cannot pick the same
      // sequence number. `seq` is UNIQUE per conversation, so without the lock
      // a double submit surfaces as a unique-violation 500 instead of an order.
      // `id` is a Prisma String (TEXT in Postgres), so no ::uuid cast here.
      await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`;
      const last = await tx.message.findFirst({
        where: { conversationId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      await tx.message.create({
        data: {
          conversationId,
          seq: (last?.seq ?? 0) + 1,
          role: body.role,
          content: body.content,
          meta: { at: body.at ?? new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });
    });

    this.logger.log({
      event: 'message.received',
      conversation_id: conversationId,
      role: body.role,
    });

    return this.runTurnFor(conversationId);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Full audit trail: what came in, what was decided, which tools fired. */
  async getConversation(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: { orderBy: { seq: 'asc' } },
        turns: { orderBy: { createdAt: 'asc' } },
        toolCalls: { orderBy: [{ turnId: 'asc' }, { seq: 'asc' }] },
        sideEffects: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!conversation) {
      throw new NotFoundException({
        code: 'conversation_not_found',
        message: `No conversation ${conversationId}`,
      });
    }

    return {
      conversation: {
        id: conversation.id,
        status: conversation.status,
        customer: conversation.customer,
        created_at: conversation.createdAt.toISOString(),
        updated_at: conversation.updatedAt.toISOString(),
      },
      messages: conversation.messages.map((message) => ({
        seq: message.seq,
        role: message.role,
        content: message.content,
        at: readAt(message.meta, message.createdAt),
      })),
      turns: conversation.turns.map((turn) => ({
        id: turn.id,
        trace_id: turn.traceId,
        status: turn.status,
        model: turn.model,
        prompt_version: turn.promptVersion,
        decision: turn.decision,
        error: turn.error,
        input_tokens: turn.inputTokens,
        output_tokens: turn.outputTokens,
        latency_ms: turn.latencyMs,
        created_at: turn.createdAt.toISOString(),
      })),
      tool_calls: conversation.toolCalls.map((call) => ({
        turn_id: call.turnId,
        seq: call.seq,
        tool: call.toolName,
        args: call.args,
        result: call.result,
        policy_outcome: call.policyOutcome,
        status: call.status,
        latency_ms: call.latencyMs,
        created_at: call.createdAt.toISOString(),
      })),
      side_effects: conversation.sideEffects.map(toSideEffectResponse),
    };
  }

  /** Tool context for an approval executed outside an agent turn. */
  async toolContextFor(conversationId: string): Promise<ToolContext> {
    const { customer } = await this.loadConversationOrThrow(conversationId);
    return {
      conversationId,
      customer,
      now: new Date(),
      log: toAgentLogger(this.logger, 'tool'),
    };
  }

  get toolRegistry(): ToolRegistry {
    return this.registry;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runTurnFor(conversationId: string): Promise<TurnResponse> {
    const { customer, messages, previousDecision } = await this.loadTurnInput(conversationId);
    const traceId = randomUUID();

    // Opened before the model is called so a crashed turn is visible as
    // `running` rather than missing entirely.
    const turn = await this.prisma.agentTurn.create({
      data: {
        conversationId,
        traceId,
        model: this.llm.model,
        promptVersion: PROMPT_VERSION,
        status: 'running',
      },
    });

    const result = await runTurn({
      conversationId,
      customer,
      messages,
      previousDecision,
      llm: this.llm,
      registry: this.registry,
      store: this.sideEffects.forTurn(turn.id),
      log: toAgentLogger(this.logger),
      traceId,
      maxIterations: env.MAX_AGENT_ITERATIONS,
      maxSideEffectsPerTurn: env.MAX_SIDE_EFFECTS_PER_TURN,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.agentTurn.update({
        where: { id: turn.id },
        data: {
          status: result.status,
          decision: result.decision as unknown as Prisma.InputJsonValue,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs: result.latencyMs,
          error: result.error ?? null,
        },
      });

      if (result.toolCalls.length > 0) {
        await tx.toolCall.createMany({
          data: result.toolCalls.map((call) => ({
            turnId: turn.id,
            conversationId,
            seq: call.seq,
            toolName: call.toolName,
            args: (call.args ?? {}) as Prisma.InputJsonValue,
            result: (call.result ?? null) as Prisma.InputJsonValue,
            policyOutcome: call.policyOutcome,
            status: call.status,
            latencyMs: call.latencyMs,
          })),
        });
      }

      // `id` is a Prisma String (TEXT in Postgres), so no ::uuid cast here.
      await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`;
      const last = await tx.message.findFirst({
        where: { conversationId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      await tx.message.create({
        data: {
          conversationId,
          seq: (last?.seq ?? 0) + 1,
          role: 'agent',
          content: result.agentReply,
          meta: { turn_id: turn.id, at: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });

      // A ticket needing a human is not "open" any more; it is waiting on one.
      await tx.conversation.update({
        where: { id: conversationId },
        data: { status: result.decision.requires_human ? 'awaiting_human' : 'open' },
      });
    });

    return {
      conversation_id: conversationId,
      turn_id: turn.id,
      trace_id: traceId,
      decision: result.decision,
      agent_reply: result.agentReply,
      degraded: result.decision.degraded,
    };
  }

  private async loadConversationOrThrow(
    conversationId: string,
  ): Promise<{ customer: CustomerProfile }> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { customer: true },
    });

    if (!conversation) {
      throw new NotFoundException({
        code: 'conversation_not_found',
        message: `No conversation ${conversationId}`,
      });
    }

    // Re-validated on read: the column is JSON, so a bad row must fail loudly
    // here rather than reaching the prompt as a malformed profile.
    return { customer: CustomerProfileSchema.parse(conversation.customer) };
  }

  private async loadTurnInput(conversationId: string): Promise<{
    customer: CustomerProfile;
    messages: ConversationMessage[];
    previousDecision: Decision | null;
  }> {
    const { customer } = await this.loadConversationOrThrow(conversationId);

    const [rows, lastTurn] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { seq: 'asc' },
      }),
      this.prisma.agentTurn.findFirst({
        where: { conversationId, status: { in: ['ok', 'failed'] } },
        orderBy: { createdAt: 'desc' },
        select: { decision: true },
      }),
    ]);

    const previous = lastTurn?.decision
      ? DecisionSchema.safeParse(lastTurn.decision)
      : undefined;

    return {
      customer,
      messages: rows.map((row) => ({
        role: row.role as ConversationMessage['role'],
        content: row.content,
        at: readAt(row.meta, row.createdAt),
      })),
      previousDecision: previous?.success ? previous.data : null,
    };
  }
}

function readAt(meta: Prisma.JsonValue | null, fallback: Date): string {
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const at = (meta as Record<string, unknown>)['at'];
    if (typeof at === 'string') return at;
  }
  return fallback.toISOString();
}
