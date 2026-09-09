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
 *  1. UNIQUE (dedup_scope_key, tool_name, dedup_key). The dedup key is derived
 *     by the server from the tool arguments, so "refund charge ch_x" is one row
 *     no matter how many times it is requested, and `dedup_scope_key` says how
 *     wide "one row" is - the descriptor's `dedupScope` decides, defaulting to
 *     the conversation id.
 *
 *     Conversation scoping matters for `issue_refund`: its key names whose
 *     money moves, and an unscoped key would let one customer's refund replay
 *     another customer's stored result. It is wrong for `open_incident`, whose
 *     key is a region - a region belongs to the fleet, not to a ticket, so
 *     conversation scoping meant one real regional outage arriving on fifty
 *     tickets filed fifty rows and called the pager provider fifty times.
 *
 *  2. Every transition is an atomic conditional UPDATE (`updateMany` with the
 *     expected status in the WHERE clause). Two concurrent approvals cannot both
 *     see `pending_approval` and both execute: exactly one gets count 1.
 *
 *  3. Write-ahead. The row reaches `executing` and is committed BEFORE the
 *     external call, so a crash between call and response leaves evidence to
 *     reconcile instead of a silent double-charge.
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Logger } from 'nestjs-pino';

import { PrismaService } from '../db/prisma.service';
import { CustomerProfileSchema } from '../agent/schema';
import { dedupScopeKeyFor } from '../agent/types';
import type { SideEffectRecord, SideEffectStore, ToolContext, ToolRegistry } from '../agent/types';
import { TOOL_REGISTRY } from './agent.providers';
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
    // The store learns a tool's dedup scope from the descriptor rather than
    // from its caller, so the runner cannot file an effect under the wrong
    // scope by forgetting to pass one. Same registry instance the runner uses.
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry,
  ) {}

  /**
   * What this (tool, dedupKey) pair collides against.
   *
   * An unregistered tool falls back to conversation scope. That is only
   * reachable when a tool was removed from the registry, and it is the safe
   * side: a too-narrow scope duplicates work, a too-wide one would let one
   * ticket's effect answer for another's.
   */
  private scopeKeyFor(toolName: string, conversationId: string): string {
    return dedupScopeKeyFor(this.registry.get(toolName)?.dedupScope, conversationId);
  }

  /**
   * The decision context copied onto a human-gated side effect when it is filed.
   *
   * `args` describes the action; this describes the decision. For a refund
   * `args` is {charge_id, amount_cents, currency, reason}, so an operator
   * authorising real money had a charge id, a number, and up to 300 characters
   * of model-written `reason` - and no way to tell whose account it was.
   *
   * Chosen for what approving a PAYMENT needs, and nothing else:
   *  - `customer_id`   whose money moves. `args` names a charge, not an
   *                    account, so without this the operator cannot say which
   *                    customer they just refunded.
   *  - `plan`          what we promised them. Refunding a free-plan customer
   *                    for a Pro charge they never got is a different decision
   *                    from a goodwill refund on enterprise.
   *  - `tenure_months` how long they have paid us: the whole of the
   *                    goodwill-versus-churn judgement.
   *  - `region`        whether this refund is compensation for an outage we
   *                    caused, which the operator can cross-check against the
   *                    open incidents for that region.
   *
   * Kept small on purpose: every field is a copy that can go stale, so it earns
   * its place only by being something the approving human cannot get otherwise.
   * Snapshotted rather than joined at read time for the same reason - the basis
   * of a pending approval must not be quietly rewritten by a later profile edit.
   *
   * The triage rationale is NOT here: see `stampTurnRationale`.
   */
  private async decisionContextFor(conversationId: string): Promise<Prisma.InputJsonValue> {
    const row = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { customer: true },
    });

    const parsed = CustomerProfileSchema.safeParse(row?.customer);
    if (!parsed.success) {
      // safeParse, not parse. Throwing here would lose the approval row
      // altogether, and a refund the agent asked for that nobody can see is
      // worse than one filed with a context the operator can tell is broken.
      // The turn that got here already validated this profile on read, so this
      // is the corrupt-row path, not the normal one.
      this.logger.warn({
        event: 'side_effect.decision_context_unavailable',
        conversation_id: conversationId,
      });
      return { customer_profile_unreadable: true };
    }

    const customer = parsed.data;
    return {
      customer_id: customer.id,
      plan: customer.plan,
      tenure_months: customer.tenure_months,
      region: customer.region,
    };
  }

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
    const dedupScopeKey = this.scopeKeyFor(input.toolName, input.conversationId);
    const where = {
      dedupScopeKey_toolName_dedupKey: {
        dedupScopeKey,
        toolName: input.toolName,
        dedupKey: input.dedupKey,
      },
    };

    // `update: {}` is deliberate: if the row already exists we return it
    // untouched. Re-requesting an approval must never reset a decided one.
    //
    // The unique-violation fallback is not redundant. Prisma's upsert is only
    // atomic when it can compile to INSERT ... ON CONFLICT, and two identical
    // refund requests in the same tool batch would otherwise surface a raw
    // P2002 to the model instead of the existing approval row.
    try {
      const row = await this.prisma.sideEffect.upsert({
        where,
        create: {
          conversationId: input.conversationId,
          dedupScopeKey,
          toolName: input.toolName,
          dedupKey: input.dedupKey,
          status: 'pending_approval',
          args: input.args as Prisma.InputJsonValue,
          decisionContext: await this.decisionContextFor(input.conversationId),
          requestedByTurnId: input.turnId,
        },
        update: {},
      });
      this.log('side_effect.requested', row.id, row.status, input);
      return toRecord(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.sideEffect.findUniqueOrThrow({ where });
    this.log('side_effect.request_deduplicated', existing.id, existing.status, input);
    return toRecord(existing);
  }

  private async beginAutonomous(input: {
    conversationId: string;
    toolName: string;
    dedupKey: string;
    args: unknown;
    turnId: string;
  }): Promise<{ outcome: 'claimed' | 'replayed' | 'in_flight'; record: SideEffectRecord }> {
    const dedupScopeKey = this.scopeKeyFor(input.toolName, input.conversationId);
    try {
      const row = await this.prisma.sideEffect.create({
        data: {
          conversationId: input.conversationId,
          dedupScopeKey,
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
        dedupScopeKey_toolName_dedupKey: {
          dedupScopeKey,
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
    const { row } = await this.settleClaim(input);
    this.logger.log({
      event: 'side_effect.transition',
      side_effect_id: row.id,
      tool: row.toolName,
      status: row.status,
    });
    return toRecord(row);
  }

  /**
   * Close a claim we may no longer hold, and never overwrite a recorded answer.
   *
   * `executing` is a LEASE, and more than one process can believe it holds one
   * for the same row: `approve` executes a human-approved effect while
   * `ReconcilerService.redriveSideEffect` re-drives the same row once its lease
   * looks stale. Both then have an outcome to write, and an unconditional
   * `update` means the LAST one wins.
   *
   * That is the worst write in the service. By the time either finishes, money
   * may have moved and the stored `result` is the only copy of the provider's
   * `refund_id` - so a late `failed` write does not just lose a race, it records
   * "did not happen" about something that did, and the id needed to reverse it
   * is gone.
   *
   * The predicate is `status = 'executing'` and deliberately NOTHING ELSE. A
   * lease token (`updated_at` as the sweeper's claim uses) would add no
   * observable protection here and would be a second, redundant mechanism: both
   * writers only ever race TOWARDS a terminal status, and a terminal row
   * already rejects both. Kept honest rather than defensive-looking, because two
   * guards where one is load-bearing is how a future edit silently removes the
   * one that mattered.
   *
   * Safe to lose, which is what makes this simple: both writers called the
   * provider with the same server-derived dedup key, so the answer already
   * recorded IS this call's answer - the same `refund_id`, by construction (see
   * `stableId`). The discarded copy is logged in full anyway, because a
   * DIFFERENT answer would be evidence that the invariant broke.
   */
  private async settleClaim(input: {
    id: string;
    status: 'succeeded' | 'failed';
    result: unknown;
  }): Promise<{ row: Row; kept: boolean }> {
    const claimed = await this.prisma.sideEffect.updateMany({
      where: { id: input.id, status: 'executing' },
      data: { status: input.status, result: input.result as Prisma.InputJsonValue },
    });

    const row = await this.prisma.sideEffect.findUniqueOrThrow({ where: { id: input.id } });
    if (claimed.count === 1) return { row, kept: true };

    // Not `needs_reconciliation`: the row is terminal and has an answer. What
    // an operator needs from this line is both copies, so a mismatch between
    // them is visible at all.
    this.logger.warn({
      event: 'side_effect.claim_lost',
      side_effect_id: row.id,
      conversation_id: row.conversationId,
      tool: row.toolName,
      dedup_key: row.dedupKey,
      stored_status: row.status,
      stored_result: row.result,
      discarded_status: input.status,
      discarded_result: input.result,
    });
    return { row, kept: false };
  }

  /**
   * Stamp a turn's triage rationale onto the side effects that turn filed.
   *
   * Separate from `decisionContextFor` because of the ordering in
   * `ConversationService.runTurnFor`: the `agent_turns` row is opened as
   * `running` with a NULL decision *before* the model is called, and the
   * decision - rationale included - is only persisted after `runTurn` returns.
   * The tool loop files its approval rows in between. So at request time there
   * is no rationale to copy; reading `agent_turns.decision` there would
   * reliably return null, and reading the PREVIOUS turn's decision would
   * attribute the wrong reasoning to this request.
   *
   * `requested_by_turn_id` is the scope, so a stamp can never put one
   * decision's reasoning on another decision's request.
   *
   * One statement, merging rather than replacing: `||` on jsonb keeps the
   * customer snapshot that was captured at request time. Read-modify-write in
   * application code would race the human approving the row.
   */
  async stampTurnRationale(turnId: string, rationale: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE side_effects
      SET decision_context = COALESCE(decision_context, '{}'::jsonb) || jsonb_build_object('rationale', ${rationale}::text),
          updated_at = NOW()
      WHERE requested_by_turn_id = ${turnId}
    `;
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

    if (claimed.count === 0) return this.explainFailedClaim(conversationId, id, 'approve');

    // From here the row is COMMITTED as `executing`, and `executing` is a dead
    // end: `explainFailedClaim` answers 409 side_effect_in_progress to every
    // later approve AND to every reject, with no sweeper and no age check to
    // release it. So every path out of this method either completes the row or
    // fails it with a recorded reason. The `tool_not_registered` branch below
    // already did that; the two after it did not, and a throw from either
    // stranded a pending refund permanently.
    //
    // The one case still not covered: a database failure inside the recovery
    // write itself leaves `executing` standing, because there is nowhere left to
    // record the failure. That is the residual the sweeper is for.
    const row = await this.prisma.sideEffect.findUniqueOrThrow({ where: { id } });

    const tool = registry.get(row.toolName);
    if (!tool) {
      // The tool was removed while an approval was pending.
      return this.failClaimed(row, 'tool_not_registered', `No tool ${row.toolName} is registered`);
    }

    // Re-validate the stored arguments at EXECUTION time, not only at filing
    // time. `row.args` comes back out of a JSON column that may have been
    // written days ago by a different deploy with a different args schema, and
    // this is the one path in the service that actually moves money. runner.ts
    // already re-validates even its own synthesised paging arguments with
    // `tool.args.safeParse` before executing; this path skipped it entirely.
    const parsedArgs = tool.args.safeParse(row.args);
    if (!parsedArgs.success) {
      return this.failClaimed(
        row,
        'invalid_stored_arguments',
        'The stored arguments no longer satisfy this tool contract',
        { issues: parsedArgs.error.issues },
      );
    }

    // Guarded, because `ctxFor` is not a pure read: it re-loads the
    // conversation and runs `CustomerProfileSchema.parse` over a JSON column,
    // so a corrupt row or a transient database error throws here - with the
    // claim already committed. It used to sit outside this block, which is
    // exactly how a pending refund became un-approvable and un-rejectable
    // forever.
    //
    // Trade-off, taken knowingly: failing the row makes a *transient* read
    // error terminal for this refund instead of retryable. That is the better
    // half of the trade - a recorded failure with a reason is something a human
    // can act on, and `executing` is something nobody can act on at all. No
    // money has moved at this point, so a human re-files rather than reconciles.
    let ctx: ToolContext;
    try {
      ctx = await ctxFor(row);
    } catch (error) {
      return this.failClaimed(row, 'context_unavailable', (error as Error).message);
    }

    let result: unknown;
    let status: 'succeeded' | 'failed';
    try {
      // `row.dedupKey` is the key this row was claimed under, so an approved
      // refund reaches the payment provider with the same idempotency key a
      // retried approval would - which is what makes the retry safe rather than
      // a second refund.
      result = await tool.execute(parsedArgs.data, ctx, row.dedupKey);
      status = (result as { ok?: boolean }).ok === false ? 'failed' : 'succeeded';
    } catch (error) {
      result = { ok: false, error: { code: 'downstream_unavailable', message: (error as Error).message } };
      status = 'failed';
    }

    let done: Row;
    let kept: boolean;
    try {
      ({ row: done, kept } = await this.settleClaim({ id, status, result }));
    } catch (error) {
      // Worst case in the whole service: the provider has been called, the
      // money has moved, and the row still says `executing`. Nothing here can
      // repair that, so make it reconcilable by hand from one log line - the id
      // to look up, and the FULL provider result, which is the only remaining
      // copy of the refund_id. Rethrown rather than swallowed: a 500 is honest,
      // a 200 claiming success would not be.
      this.logger.error({
        event: 'side_effect.result_not_persisted',
        needs_reconciliation: true,
        side_effect_id: id,
        conversation_id: conversationId,
        tool: row.toolName,
        dedup_key: row.dedupKey,
        intended_status: status,
        provider_result: result,
        error: (error as Error).message,
      });
      throw error;
    }

    this.logger.log({
      event: 'side_effect.approved',
      side_effect_id: id,
      tool: done.toolName,
      status: done.status,
    });
    // `replayed` describes what the CALLER is being handed, so a row settled by
    // another writer is a replay of that writer's answer even though this
    // request did call the provider. Reporting `false` here would tell an
    // operator that the status they can see is this request's own outcome.
    return { side_effect: toSideEffectResponse(done), replayed: !kept };
  }

  /**
   * Terminate a row we have already claimed as `executing` but will not
   * execute, recording why. The alternative - letting the caller throw - leaves
   * the row in `executing`, which no later approve or reject can move.
   */
  private async failClaimed(
    row: Row,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<{ side_effect: SideEffectResponse; replayed: boolean }> {
    // Conditional for the same reason as every other terminal write: `ctxFor`
    // is a database read, and a read that stalls past the side-effect lease is
    // long enough for the sweeper to have re-driven this row to a real answer.
    const { row: failed, kept } = await this.settleClaim({
      id: row.id,
      status: 'failed',
      result: { ok: false, error: { code, message, ...extra } },
    });
    this.logger.error({
      event: 'side_effect.claim_failed',
      side_effect_id: row.id,
      conversation_id: row.conversationId,
      tool: row.toolName,
      dedup_key: row.dedupKey,
      code,
      message,
    });
    return { side_effect: toSideEffectResponse(failed), replayed: !kept };
  }

  async reject(conversationId: string, id: string): Promise<{ side_effect: SideEffectResponse }> {
    const rejected = await this.prisma.sideEffect.updateMany({
      where: { id, conversationId, status: 'pending_approval' },
      data: { status: 'rejected' },
    });

    // Lost the claim: either it is already rejected (idempotent, return it) or
    // it is in another state, which explainFailedClaim turns into a conflict.
    if (rejected.count === 0) {
      const { side_effect } = await this.explainFailedClaim(conversationId, id, 'reject');
      return { side_effect };
    }

    const row = await this.prisma.sideEffect.findUniqueOrThrow({ where: { id } });
    this.logger.log({ event: 'side_effect.rejected', side_effect_id: id, tool: row.toolName });
    return { side_effect: toSideEffectResponse(row) };
  }

  /**
   * Turn a lost conditional UPDATE into the right HTTP answer.
   *
   * The answer depends on what the caller was trying to do, which is why
   * `intent` is a parameter rather than being inferred from the row: repeating
   * a decision that already happened is idempotent, but reversing one is a
   * conflict. Approving an action a human already rejected must never look like
   * success.
   */
  private async explainFailedClaim(
    conversationId: string,
    id: string,
    intent: 'approve' | 'reject',
  ): Promise<{ side_effect: SideEffectResponse; replayed: boolean }> {
    const row = await this.prisma.sideEffect.findUnique({ where: { id } });

    if (!row || row.conversationId !== conversationId) {
      throw new NotFoundException({
        code: 'side_effect_not_found',
        message: `No side effect ${id} on conversation ${conversationId}`,
      });
    }

    const response = toSideEffectResponse(row);

    switch (row.status) {
      case 'succeeded':
      case 'failed':
        if (intent === 'reject') {
          throw new ConflictException({
            code: 'side_effect_already_executed',
            message: 'This action was already executed and cannot be rejected',
          });
        }
        // Already executed: replay the stored outcome. This is what makes a
        // retried approval safe rather than a second refund.
        return { side_effect: response, replayed: true };

      case 'executing':
        throw new ConflictException({
          code: 'side_effect_in_progress',
          message: 'This action is currently executing',
        });

      case 'rejected':
        if (intent === 'approve') {
          throw new ConflictException({
            code: 'side_effect_rejected',
            message: 'A human rejected this action; it cannot be approved',
          });
        }
        // Rejecting an already-rejected action is a no-op, not an error.
        return { side_effect: response, replayed: false };

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
