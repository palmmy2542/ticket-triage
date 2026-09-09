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
            visibility: 'customer',
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
          // Derived, never taken from the request: a client must not be able to
          // record an internal exchange as something the customer has seen.
          visibility: body.role === 'customer' ? 'customer' : 'internal',
          meta: { at: body.at ?? new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });
    });

    this.logger.log({
      event: 'message.received',
      conversation_id: conversationId,
      role: body.role,
    });

    // A customer message is work to triage; an operator message is a question,
    // unless the operator authorized this turn to act.
    return this.runTurnFor(conversationId, {
      sideEffectsAuthorized: body.role === 'customer' || body.authorize_actions,
    });
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
        visibility: message.visibility,
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

  private async runTurnFor(
    conversationId: string,
    options: { sideEffectsAuthorized?: boolean } = {},
  ): Promise<TurnResponse> {
    const { customer, messages, previousDecision, openApprovals } =
      await this.loadTurnInput(conversationId);
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
      sideEffectsAuthorized: options.sideEffectsAuthorized ?? true,
      openApprovals,
    });

    // One transaction, and deliberately NOT retried. A bounded retry for lock
    // conflicts lived here and was deleted: with the lock order below fixed,
    // the deadlock it existed for stopped happening, and both of its mutations
    // survived - nothing could tell whether the retry ran. What covers the
    // residual is `ReconcilerService.sweepTurns`, which is durable across a
    // process death as an in-request retry never is.
    await this.prisma.$transaction(async (tx) => {
      // FIRST, before anything else in this transaction.
      //
      // `tool_calls`, `messages` and `agent_turns` all carry an FK to
      // `conversations(id)`, so every row inserted or updated below takes a
      // `FOR KEY SHARE` lock on this same parent row. Taking the weak locks
      // first and then asking to UPGRADE to `FOR UPDATE` - which is what the
      // old statement order did - deadlocks two concurrent turns on the same
      // conversation: each holds KEY SHARE, each waits for the other to drop it.
      // Reproduced against this project's Postgres:
      // `ERROR: deadlock detected ... while locking tuple (0,1)`.
      //
      // The loser's whole transaction aborted, which meant the turn stayed
      // `running`, its tool_calls were never persisted and no agent reply was
      // written - while its side effects, committed outside this transaction,
      // had already paged on-call. `addMessage` above always took these two
      // locks in this order; the inversion here was an accident, not a design.
      //
      // `id` is a Prisma String (TEXT in Postgres), so no ::uuid cast here.
      await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`;

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

      // Read AFTER the lock, so a concurrent turn cannot hand us the same `seq`
      // (`messages` is UNIQUE on (conversation_id, seq)).
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
          // `agentReply` is `decision.operator_summary` - a note to whoever is
          // handling the ticket. The customer-facing text of this same turn is
          // `decision.customer_reply_draft`, which nothing here sends.
          visibility: 'internal',
          meta: { turn_id: turn.id, at: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });

      // A ticket needing a human is not "open" any more; it is waiting on one.
      await tx.conversation.update({
        where: { id: conversationId },
        data: { status: result.decision.requires_human ? 'awaiting_human' : 'open' },
      });
    });

    // Stamp this turn's rationale onto the approval rows it filed. Deliberately
    // AFTER the transaction and on its own connection: it is repair of an
    // audit field, not part of the turn's atomic write, and rolling the turn
    // back over a failed stamp would trade a decision for a comment.
    //
    // It cannot happen at request time. The agent_turns row is opened `running`
    // with a NULL decision before the model is called, and the tool loop files
    // its approval rows while that is still true - so at the moment a refund is
    // filed there is no rationale in existence to copy. An operator asked to
    // authorise money needs to know WHY the agent asked, which is exactly what
    // this carries.
    // Guarded, because it is a write on its own connection AFTER the turn has
    // committed: a pool blip here used to answer 500 for a turn whose decision,
    // reply and side-effect rows had all landed - and a 500 out of an
    // `@Idempotent` route also burns the key, so the client's retry is refused
    // as well. The failure is an audit field the operator can be told about,
    // not a decision to throw away.
    if (result.decision.rationale) {
      try {
        await this.sideEffects.stampTurnRationale(turn.id, result.decision.rationale);
      } catch (error) {
        this.logger.error({
          event: 'side_effect.rationale_not_stamped',
          needs_reconciliation: true,
          turn_id: turn.id,
          conversation_id: conversationId,
          error: (error as Error).message,
        });
      }
    }

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
    openApprovals: number;
  }> {
    const { customer } = await this.loadConversationOrThrow(conversationId);

    const [rows, lastTurn, openApprovals] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { seq: 'asc' },
      }),
      this.prisma.agentTurn.findFirst({
        where: { conversationId, status: { in: ['ok', 'failed'] } },
        orderBy: { createdAt: 'desc' },
        select: { decision: true },
      }),
      // Ticket-wide, not turn-wide: a refund THIS turn did not file is still a
      // decision a human is holding, and the guard that refuses to auto-respond
      // over one cannot see it from the turn's own tool records.
      this.prisma.sideEffect.count({
        where: { conversationId, status: 'pending_approval' },
      }),
    ]);

    const previous = lastTurn?.decision ? DecisionSchema.safeParse(lastTurn.decision) : undefined;

    return {
      customer,
      messages: rows.map((row) => ({
        role: row.role as ConversationMessage['role'],
        content: row.content,
        at: readAt(row.meta, row.createdAt),
      })),
      previousDecision: previous?.success ? previous.data : null,
      openApprovals,
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
