/**
 * One reconciliation pass over the three states that are leases with no expiry.
 *
 * The same shape appears three times: a non-terminal status whose exit depends
 * on the originating process surviving long enough to write the exit. Nothing
 * ages any of them out and no endpoint lists them, so each one is invisible
 * until a customer complains.
 *
 *   side_effects.status      = 'executing'    -> re-drive, or quarantine
 *   agent_turns.status       = 'running'      -> fail-safe decision + reply
 *   idempotency_keys.status  = 'in_progress'  -> terminal, replayable failure
 *
 * plus retention for `idempotency_keys`, which never removed a row.
 *
 * WHY ONE PASS AND NOT THREE. They share the invariant that a sweeper must
 * never resolve live work, and they share one place to get the staleness
 * arithmetic right. Two numbers come out of it, both derived in
 * `reconciler.threshold.ts` and both reported by every sweep:
 *
 *  - the TURN bound for `agent_turns` and `idempotency_keys`, which measures a
 *    whole request (model attempts x iterations x slack);
 *  - the per-call bound for `side_effects`, which measures ONE provider call.
 *
 * They are separate because the recovery actions differ in kind: re-driving a
 * side effect is idempotent (the result id is a pure function of the dedup
 * key), while handing a turn a fail-safe decision is not. Tight is safe for
 * the first and dangerous for the second - see the threshold file.
 *
 * WHY A `setInterval` AND NOT A SCHEDULER. This is the smallest honest
 * mechanism that runs the pass without a queue, a cron container, or
 * @nestjs/schedule. What it costs, stated plainly:
 *
 *  - Every replica sweeps. That is safe here but not free: correctness comes
 *    from each row being claimed by an atomic conditional UPDATE (see
 *    `redriveSideEffect` and `failSafeTurn`), so N replicas do the work once
 *    between them, but they all pay for the scan. A real deployment wants a
 *    leader lock (`pg_try_advisory_lock`) or a single scheduled worker.
 *  - The interval is not durable. A process that is down does not sweep, so
 *    the effective recovery time is bounded by uptime, not by the interval.
 *  - `unref()`d, so it never holds the process open at shutdown; a sweep
 *    already in flight when `onApplicationShutdown` runs is abandoned mid-pass.
 *    That is acceptable precisely because every step is idempotent and
 *    re-claimable: the next sweep on any replica picks the row up again.
 */
import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Logger } from 'nestjs-pino';

import { applyGuards, failSafeDecision } from '../agent/runner';
import { CustomerProfileSchema } from '../agent/schema';
import type { ToolContext, ToolRegistry } from '../agent/types';
import { env } from '../config/env';
import { PrismaService } from '../db/prisma.service';
import { TOOL_REGISTRY } from './agent.providers';
import { toAgentLogger } from './agent-logger';
import { deriveSideEffectStaleAfterMs, deriveStaleAfterMs } from './reconciler.threshold';

export interface SweepReport {
  /** The derived turn threshold this pass used, so a log line explains its own cutoff. */
  staleAfterMs: number;
  /** The tighter threshold used for `side_effects`, which are one call and not one turn. */
  sideEffectStaleAfterMs: number;
  sideEffects: {
    /** Re-driven to a terminal status with the provider's answer recorded. */
    redriven: string[];
    /** Could not be re-driven safely; failed with a reason a human can act on. */
    quarantined: string[];
    /**
     * Re-drive threw. Deliberately left `executing` so the gauge stays
     * non-zero and the next sweep retries - see `redriveSideEffect`.
     */
    unresolved: string[];
  };
  turns: {
    /** Given the fail-safe end state: reply written, ticket moved to the human queue. */
    failedSafe: string[];
    /**
     * Closed as `failed` and nothing more, because a LATER turn had already
     * answered this conversation - see `failSafeTurn`.
     */
    superseded: string[];
  };
  idempotencyKeys: { abandoned: string[]; purged: number };
}

@Injectable()
export class ReconcilerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry,
  ) {}

  onApplicationBootstrap(): void {
    // Not under test: a timer firing between a `truncateAll` and an assertion
    // is a race, and every test drives `sweep()` directly instead. The one test
    // that does exercise the timer calls `startSweeping` itself.
    if (env.NODE_ENV === 'test' || env.RECONCILE_INTERVAL_MS === 0) return;
    this.startSweeping(env.RECONCILE_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    this.stopSweeping();
  }

  startSweeping(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Never keep the event loop alive for a sweep. Without this a Jest worker
    // hangs after the suite and a SIGTERM waits out the full interval.
    this.timer.unref();
    this.logger.log({ event: 'reconcile.started', interval_ms: intervalMs });
  }

  stopSweeping(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One tick. Two things it must never do: overlap itself, and throw.
   *
   * Overlap, because a sweep slower than the interval would stack up and each
   * copy holds pool connections - a reconciler that exhausts the pool takes
   * down the request path it exists to protect. (The per-row claims already
   * make CONCURRENT sweepers safe; this is about resource use, not correctness.)
   *
   * Throw, because an unhandled rejection out of a `setInterval` callback is a
   * process crash, and crashing the service is how this sweeper would create
   * exactly the stranded rows it cleans up.
   */
  private async tick(): Promise<void> {
    if (this.inFlight) {
      this.logger.warn({ event: 'reconcile.sweep_overlapped' });
      return;
    }
    this.inFlight = true;
    try {
      await this.sweep();
    } catch (error) {
      this.logger.error({
        event: 'reconcile.sweep_failed',
        error: (error as Error).message,
      });
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * The whole pass, callable so a test can drive it without waiting on a timer.
   *
   * Stale `in_progress` keys are aged into `failed` before retention runs, so a
   * wedged key becomes replayable in the same pass. That ordering is DEFENSIVE
   * only, and the comment says so on purpose: what actually stops retention
   * deleting a wedged key is the `status IN ('completed','failed')` predicate in
   * `purgeIdempotencyKeys`, not the order. Mutation-tested - each of the two
   * masks the other, so neither alone is observable, and both are kept because
   * the pair is what survives a future edit to either.
   */
  async sweep(now = new Date()): Promise<SweepReport> {
    const staleAfterMs = deriveStaleAfterMs({
      llmTimeoutMs: env.LLM_TIMEOUT_MS,
      maxIterations: env.MAX_AGENT_ITERATIONS,
      multiplier: env.RECONCILE_STALE_MULTIPLIER,
    });
    const sideEffectStaleAfterMs = deriveSideEffectStaleAfterMs({
      llmTimeoutMs: env.LLM_TIMEOUT_MS,
      multiplier: env.RECONCILE_STALE_MULTIPLIER,
    });
    const cutoff = new Date(now.getTime() - staleAfterMs);

    const report: SweepReport = {
      staleAfterMs,
      sideEffectStaleAfterMs,
      sideEffects: await this.sweepSideEffects(
        new Date(now.getTime() - sideEffectStaleAfterMs),
      ),
      turns: await this.sweepTurns(cutoff),
      idempotencyKeys: {
        abandoned: await this.sweepIdempotencyKeys(cutoff),
        purged: await this.purgeIdempotencyKeys(
          new Date(now.getTime() - env.IDEMPOTENCY_RETENTION_MS),
        ),
      },
    };

    const total =
      report.sideEffects.redriven.length +
      report.sideEffects.quarantined.length +
      report.sideEffects.unresolved.length +
      report.turns.failedSafe.length +
      report.turns.superseded.length +
      report.idempotencyKeys.abandoned.length;

    // Logged only when it did something. A heartbeat every minute saying "zero"
    // is a line operators learn to filter, and filtering it hides the one that
    // matters.
    if (total > 0 || report.idempotencyKeys.purged > 0) {
      this.logger.log({
        event: 'reconcile.sweep',
        stale_after_ms: staleAfterMs,
        side_effect_stale_after_ms: sideEffectStaleAfterMs,
        side_effects_redriven: report.sideEffects.redriven.length,
        side_effects_quarantined: report.sideEffects.quarantined.length,
        side_effects_unresolved: report.sideEffects.unresolved.length,
        turns_failed_safe: report.turns.failedSafe.length,
        turns_superseded: report.turns.superseded.length,
        idempotency_keys_abandoned: report.idempotencyKeys.abandoned.length,
        idempotency_keys_purged: report.idempotencyKeys.purged,
      });
    }

    return report;
  }

  // -------------------------------------------------------------------------
  // 1. side_effects.status = 'executing'
  // -------------------------------------------------------------------------

  private async sweepSideEffects(cutoff: Date): Promise<SweepReport['sideEffects']> {
    const rows = await this.prisma.sideEffect.findMany({
      where: { status: 'executing', updatedAt: { lt: cutoff } },
      orderBy: { updatedAt: 'asc' },
      take: env.RECONCILE_BATCH_SIZE,
    });

    const out: SweepReport['sideEffects'] = { redriven: [], quarantined: [], unresolved: [] };
    for (const row of rows) {
      // Per row, so one poisoned row cannot stop the pass for the rest -
      // including for a refund behind it in the queue.
      try {
        const outcome = await this.redriveSideEffect(row);
        if (outcome) out[outcome].push(row.id);
      } catch (error) {
        out.unresolved.push(row.id);
        this.logger.error({
          event: 'reconcile.side_effect_unresolved',
          needs_reconciliation: true,
          side_effect_id: row.id,
          conversation_id: row.conversationId,
          tool: row.toolName,
          dedup_key: row.dedupKey,
          error: (error as Error).message,
        });
      }
    }
    return out;
  }

  /**
   * Re-drive a stranded side effect, rather than failing it or filing it for a
   * human. The choice turns on one property of this system, and it is worth
   * relying on explicitly:
   *
   *   every side-effecting tool derives its result id from the SERVER-derived
   *   dedup key - `stableId('re', dedupKey)` in tools/support.ts - exactly as a
   *   payment provider derives it from an idempotency key.
   *
   * So re-driving the identical call cannot move money twice and cannot mint a
   * second `refund_id`: it returns the very id the crashed attempt lost. That
   * makes re-driving strictly better than the alternatives.
   *
   *  - Failing the row blindly is the worst option: money may already have
   *    moved and `refund_id` is the only handle on it, so we would be recording
   *    "did not happen" about something that did.
   *  - Quarantining for a human is safe but wasteful HERE: the human's only
   *    move is to look up the provider's record of the same idempotency key,
   *    which is a value we can compute. Quarantine is kept for the cases where
   *    we genuinely cannot make the call - see the two guards below.
   *
   * What this leans on and would not survive without: the id must stay a pure
   * function of the dedup key. A tool that returned a provider-generated id
   * would make re-driving a double-charge risk, and this method would have to
   * become a read of the provider's record instead. That is the one invariant
   * to check before adding a side-effecting tool.
   */
  private async redriveSideEffect(
    row: Prisma.SideEffectGetPayload<object>,
  ): Promise<'redriven' | 'quarantined' | null> {
    const tool = this.registry.get(row.toolName);
    if (!tool) {
      // The tool was removed by a deploy while this row was in flight. Nothing
      // can re-drive it, so record a reason instead of leaving it un-actionable.
      return this.quarantine(row, 'tool_not_registered', `No tool ${row.toolName} is registered`);
    }

    // Re-validated at EXECUTION time, the same check `SideEffectsService.approve`
    // makes and for the same reason: `args` came out of a JSON column that may
    // have been written by a previous deploy with a different schema, and this
    // is the path that moves money. Never call a provider with arguments we
    // cannot check.
    const parsedArgs = tool.args.safeParse(row.args);
    if (!parsedArgs.success) {
      return this.quarantine(
        row,
        'invalid_stored_arguments',
        'The stored arguments no longer satisfy this tool contract',
        { issues: parsedArgs.error.issues },
      );
    }

    let ctx: ToolContext;
    try {
      ctx = await this.toolContextFor(row.conversationId);
    } catch (error) {
      return this.quarantine(row, 'context_unavailable', (error as Error).message);
    }

    // Claim the row by RENEWING its lease: the conditional predicate is the
    // same one the scan used, so exactly one sweeper wins even with N replicas
    // sweeping, and `updated_at` moves forward so the loser's predicate no
    // longer matches. Status deliberately stays `executing` - it is the truth
    // (this process is executing it now), it needs no new state that
    // `explainFailedClaim` would answer 409 `side_effect_invalid_state` to, and
    // a crash of THIS process leaves the row exactly as it found it, one
    // threshold away from the next attempt.
    const claim = await this.prisma.sideEffect.updateMany({
      where: { id: row.id, status: 'executing', updatedAt: row.updatedAt },
      data: { status: 'executing', updatedAt: new Date() },
    });
    if (claim.count === 0) return null;

    let result: unknown;
    let status: 'succeeded' | 'failed';
    try {
      // `row.dedupKey` - the key the row was claimed under, never a fresh one.
      // The whole safety argument above is that the provider sees the same
      // idempotency key the crashed attempt sent it.
      result = await tool.execute(parsedArgs.data, ctx, row.dedupKey);
      status = (result as { ok?: boolean }).ok === false ? 'failed' : 'succeeded';
    } catch (error) {
      // THROWN means infrastructure: a timeout, a 503, a gateway we could not
      // reach. That is not an answer, so we do not record one. The lease we
      // just renewed expires and the next sweep tries again - free, because the
      // id is a pure function of the dedup key - and until then the row stays
      // `executing`, which keeps it on the gauge that should read zero. Closing
      // it as `failed` here would clear the alert without resolving anything.
      throw error;
    }

    // Conditional on the row still being ours to close, and for the reason the
    // whole re-drive exists: the stored result is the only copy of the
    // provider's id. While we were at the provider, the request path may have
    // settled the same row - a human approving the same refund executes it
    // through `SideEffectsService.approve`, which holds no lock against us -
    // and an unconditional write would replace a succeeded refund with this
    // attempt's transient failure. Both attempts sent the same idempotency key,
    // so the answer already recorded IS our answer.
    const settled = await this.prisma.sideEffect.updateMany({
      where: { id: row.id, status: 'executing' },
      data: { status, result: result as Prisma.InputJsonValue },
    });
    if (settled.count === 0) {
      const current = await this.prisma.sideEffect.findUnique({ where: { id: row.id } });
      // Both copies, so a genuine mismatch between them is visible at all.
      this.logger.warn({
        event: 'reconcile.side_effect_settled_elsewhere',
        side_effect_id: row.id,
        conversation_id: row.conversationId,
        tool: row.toolName,
        dedup_key: row.dedupKey,
        stored_status: current?.status,
        stored_result: current?.result,
        discarded_status: status,
        discarded_result: result,
      });
      return null;
    }
    const done = await this.prisma.sideEffect.findUniqueOrThrow({ where: { id: row.id } });

    // `warn`, not `log`: a reconciled row means a process died holding a lease,
    // which is not routine. `provider_result` in full because on the money path
    // this line is the second copy of the refund_id.
    this.logger.warn({
      event: 'reconcile.side_effect_redriven',
      side_effect_id: row.id,
      conversation_id: row.conversationId,
      tool: row.toolName,
      dedup_key: row.dedupKey,
      stranded_since: row.updatedAt.toISOString(),
      status: done.status,
      provider_result: result,
    });
    return 'redriven';
  }

  private async quarantine(
    row: Prisma.SideEffectGetPayload<object>,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<'quarantined' | null> {
    const claimed = await this.prisma.sideEffect.updateMany({
      where: { id: row.id, status: 'executing', updatedAt: row.updatedAt },
      data: {
        status: 'failed',
        result: { ok: false, error: { code, message, ...extra } } as Prisma.InputJsonValue,
      },
    });
    if (claimed.count === 0) return null;

    this.logger.error({
      event: 'reconcile.side_effect_quarantined',
      needs_reconciliation: true,
      side_effect_id: row.id,
      conversation_id: row.conversationId,
      tool: row.toolName,
      dedup_key: row.dedupKey,
      code,
      message,
    });
    return 'quarantined';
  }

  /**
   * Tool context for a call made outside any agent turn.
   *
   * Built here from Prisma rather than borrowed from `ConversationService`
   * because the reconciler must not depend on the request path it repairs after.
   * `CustomerProfileSchema.parse` is the same re-validation-on-read that service
   * does: the column is JSON, so a corrupt row has to fail loudly rather than
   * reach a payment provider as a malformed profile.
   */
  private async toolContextFor(conversationId: string): Promise<ToolContext> {
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { customer: true },
    });
    return {
      conversationId,
      customer: CustomerProfileSchema.parse(conversation.customer),
      now: new Date(),
      log: toAgentLogger(this.logger, 'reconciler'),
    };
  }

  // -------------------------------------------------------------------------
  // 2. agent_turns.status = 'running'
  // -------------------------------------------------------------------------

  private async sweepTurns(cutoff: Date): Promise<SweepReport['turns']> {
    // `created_at`, not `updated_at`: `agent_turns` has no `updated_at` column,
    // and `created_at` is the moment the lease was taken anyway - the row is
    // opened `running` before the model is called and written exactly once more.
    const rows = await this.prisma.agentTurn.findMany({
      where: { status: 'running', createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: env.RECONCILE_BATCH_SIZE,
    });

    const out: SweepReport['turns'] = { failedSafe: [], superseded: [] };
    for (const row of rows) {
      try {
        const outcome = await this.failSafeTurn(row);
        if (outcome) out[outcome].push(row.id);
      } catch (error) {
        this.logger.error({
          event: 'reconcile.turn_unresolved',
          needs_reconciliation: true,
          turn_id: row.id,
          conversation_id: row.conversationId,
          error: (error as Error).message,
        });
      }
    }
    return out;
  }

  /**
   * Bring an abandoned turn to the SAME end state a degraded turn reaches.
   *
   * Marking it `failed` and stopping would swap a silent loss for a slightly
   * less silent one: no reply, `conversation.status` unchanged, and still no
   * endpoint that lists it. The runner already produces the end state that
   * gets a ticket looked at - urgency `high`, `escalate_to_human`,
   * `degraded: true`, `requires_human: true`, plus an agent message and
   * `conversation.status = 'awaiting_human'` - so the reconciler's job is to
   * produce that, not a new third outcome.
   *
   * WHY REUSE `failSafeDecision` / `applyGuards` RATHER THAN HAND-WRITE ONE.
   * The alternative is a second definition of "what a degraded turn looks
   * like", and the two would drift the first time a guard changes - at which
   * point an abandoned ticket stops matching the queue that degraded tickets
   * land in, which is the entire point of the fix. Both are pure exported
   * functions of their arguments with no I/O, so the coupling costs an import
   * and buys the invariant. `records: []` is honest: an aborted request's
   * `tool_calls` were in the transaction that rolled back, so nothing ran that
   * we have a record of, and inventing entries would be worse than an empty
   * `tools_used`. Its side EFFECTS were committed outside that transaction and
   * are handled by the pass above, not here.
   *
   * BOUNDED TO THE LATEST TURN, which is the difference between repairing a
   * conversation and talking over it. A turn aborts, the operator asks again,
   * the second turn answers and replies - and this one is still `running`
   * twelve minutes later. Nobody is waiting for it: appending its fail-safe
   * reply after the real one contradicts what the customer was already told,
   * and `awaiting_human` reopens a ticket whose own decision closed it. So a
   * superseded turn is closed as `failed` with its reason and nothing else -
   * the lease is released, the audit trail says what happened, and no decision
   * is invented for a turn that never made one.
   */
  private async failSafeTurn(row: {
    id: string;
    conversationId: string;
    model: string;
    createdAt: Date;
  }): Promise<'failedSafe' | 'superseded' | null> {
    const reason = `abandoned: no result recorded since ${row.createdAt.toISOString()}`;
    const { decision } = applyGuards({
      base: failSafeDecision(reason),
      records: [],
      degraded: true,
      model: row.model,
      injection: null,
    });

    const wrote = await this.prisma.$transaction(async (tx): Promise<'failedSafe' | 'superseded' | null> => {
      // FIRST, and in this order, for the reason spelled out in
      // conversation.service.ts: every row written below carries an FK to
      // `conversations(id)` and so takes `FOR KEY SHARE` on this same parent
      // row. Taking the weak locks first and then upgrading deadlocks against a
      // concurrent turn. Taking `FOR UPDATE` up front also serialises this
      // transaction against a turn's own closing transaction, which takes the
      // identical lock first.
      await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${row.conversationId} FOR UPDATE`;

      // Read inside the lock, so a turn committing right now is either already
      // visible here or blocked behind us.
      const newer = await tx.agentTurn.findFirst({
        where: { conversationId: row.conversationId, createdAt: { gt: row.createdAt } },
        select: { id: true },
      });

      // Conditional, and INSIDE the lock. If the request was in fact still
      // alive and committed while we were deciding, its transaction moved the
      // status off `running` and this finds nothing - so we never overwrite a
      // real decision with a fail-safe one.
      const claimed = await tx.agentTurn.updateMany({
        where: { id: row.id, status: 'running' },
        data: {
          status: 'failed',
          decision: newer ? undefined : (decision as unknown as Prisma.InputJsonValue),
          error: reason,
          latencyMs: null,
        },
      });
      if (claimed.count === 0) return null;

      // Superseded: the lease is released and the audit trail records why, but
      // the conversation belongs to the turn that answered it.
      if (newer) return 'superseded';

      // Read AFTER the lock: `messages` is UNIQUE on (conversation_id, seq), so
      // reading before it is how two writers pick the same number.
      const last = await tx.message.findFirst({
        where: { conversationId: row.conversationId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      await tx.message.create({
        data: {
          conversationId: row.conversationId,
          seq: (last?.seq ?? 0) + 1,
          role: 'agent',
          content: decision.operator_summary,
          // The operator summary, like every other agent row: this repairs the
          // audit trail and the queue, it does not write to a customer.
          visibility: 'internal',
          meta: {
            turn_id: row.id,
            at: new Date().toISOString(),
            reconciled: true,
          } as Prisma.InputJsonValue,
        },
      });

      // The state change that actually makes the ticket findable: it is not
      // "open" any more, it is waiting on a human.
      await tx.conversation.update({
        where: { id: row.conversationId },
        data: { status: decision.requires_human ? 'awaiting_human' : 'open' },
      });

      return 'failedSafe';
    });

    if (!wrote) return null;

    if (wrote === 'superseded') {
      this.logger.warn({
        event: 'reconcile.turn_abandoned_superseded',
        turn_id: row.id,
        conversation_id: row.conversationId,
        abandoned_since: row.createdAt.toISOString(),
      });
      return 'superseded';
    }

    this.logger.warn({
      event: 'reconcile.turn_abandoned',
      turn_id: row.id,
      conversation_id: row.conversationId,
      abandoned_since: row.createdAt.toISOString(),
      urgency: decision.urgency,
      next_action: decision.next_action,
      requires_human: decision.requires_human,
      degraded: decision.degraded,
    });
    return 'failedSafe';
  }

  // -------------------------------------------------------------------------
  // 3. idempotency_keys.status = 'in_progress', and retention
  // -------------------------------------------------------------------------

  /**
   * Age a wedged key into the TERMINAL `failed` status.
   *
   * Deleting the row instead - which would let the retry actually succeed - is
   * the option `IdempotencyInterceptor.recordFailure` already rejected, and its
   * argument holds identically here: the crashed attempt may have committed a
   * conversation, a turn, and side-effect rows before it died, and a retry that
   * created a SECOND conversation would get a fresh dedup scope for every
   * conversation-scoped effect. `issue_refund` is the one that matters -
   * `<customer>:<charge>` under a new conversation id is a new row, so the same
   * charge can be filed for approval twice and authorised twice by two
   * operators who cannot see each other's queue. (Paging is no longer the
   * example: `open_incident` is globally scoped, so one outage stays one
   * incident however many conversations report it.)
   *
   * So the fix is not "make the retry work", it is "stop answering 409 forever":
   * the key becomes a replayable, recorded failure the client can see and act on
   * by minting a new key, and retention removes it once it can no longer be
   * confused with live work.
   *
   * 503 rather than 500: the attempt did not fail, it disappeared. That is the
   * status a client's own retry policy should treat as retryable-with-a-new-key.
   */
  private async sweepIdempotencyKeys(cutoff: Date): Promise<string[]> {
    const rows = await this.prisma.idempotencyKey.findMany({
      where: { status: 'in_progress', updatedAt: { lt: cutoff } },
      orderBy: { updatedAt: 'asc' },
      take: env.RECONCILE_BATCH_SIZE,
      select: { key: true, route: true, updatedAt: true },
    });

    const out: string[] = [];
    for (const row of rows) {
      const claimed = await this.prisma.idempotencyKey.updateMany({
        where: { key: row.key, status: 'in_progress', updatedAt: row.updatedAt },
        data: {
          status: 'failed',
          statusCode: 503,
          // Stored verbatim as the body a replay re-throws, so the client sees
          // this exact answer rather than a bare 500 with no explanation.
          response: {
            code: 'request_abandoned',
            message:
              'The request holding this Idempotency-Key did not complete and its outcome is ' +
              'unknown. Retry with a NEW key; some of its effects may already have been applied.',
          } as Prisma.InputJsonValue,
        },
      });
      if (claimed.count === 0) continue;

      out.push(row.key);
      this.logger.warn({
        event: 'reconcile.idempotency_key_abandoned',
        idempotency_key: row.key,
        route: row.route,
        wedged_since: row.updatedAt.toISOString(),
        status_code: 503,
      });
    }
    return out;
  }

  /**
   * Retention. Nothing else ever removed a row, so the table grew without
   * bound - and an unbounded table of keys is also an unbounded 422 surface,
   * since every historical key keeps rejecting a reused key forever.
   *
   * TERMINAL rows only, filtered on BOTH the select and the delete. Deleting an
   * `in_progress` row would release the key and reopen the second-conversation
   * hole above; that row belongs to the pass before this one. The duplication is
   * deliberate and mutation-tested: dropping either filter alone changes
   * nothing, and it takes both plus a reordering of `sweep` to delete a wedged
   * key - which is the point of writing the predicate twice on the one query in
   * this file that destroys data.
   *
   * Bounded by ids rather than one unqualified `DELETE ... WHERE updated_at <
   * $1`, so a first run against a table that has been growing for months takes
   * many small transactions instead of one long one holding locks.
   *
   * The cost, stated: past the window a retry of a `completed` key RE-RUNS the
   * request instead of replaying it. 24h is the window payment APIs promise for
   * exactly this reason, and a client retrying a day later is not retrying, it
   * is making a new request.
   */
  private async purgeIdempotencyKeys(before: Date): Promise<number> {
    const rows = await this.prisma.idempotencyKey.findMany({
      where: { status: { in: ['completed', 'failed'] }, updatedAt: { lt: before } },
      orderBy: { updatedAt: 'asc' },
      take: env.RECONCILE_BATCH_SIZE,
      select: { key: true },
    });
    if (rows.length === 0) return 0;

    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { key: { in: rows.map((r) => r.key) }, status: { in: ['completed', 'failed'] } },
    });
    this.logger.log({ event: 'reconcile.idempotency_keys_purged', count, before: before.toISOString() });
    return count;
  }
}
