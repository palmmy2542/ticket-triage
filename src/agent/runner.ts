/**
 * The agent loop.
 *
 * Responsibilities, in order of how much they matter:
 *  1. Never let the model perform an action it is not allowed to perform.
 *  2. Never lose a ticket, whatever the model or a downstream service does.
 *  3. Produce a decision object that reflects what actually happened, not what
 *     the model says happened.
 *  4. Leave a reconstructable trail (structured log events + returned records).
 */
import { randomUUID } from 'node:crypto';

import { buildMessages, PROMPT_VERSION } from './prompt';
import { evaluate, type PolicyDecision } from './policy';
import { detectInjectionAttempt, type InjectionFinding } from './rules/injection';
import { detectRegionalOutage, incidentFor } from './rules/regional-outage';
import {
  DECISION_RESPONSE_FORMAT_NAME,
  ModelDecisionSchema,
  strictJsonSchema,
  type Decision,
  type ModelDecision,
  type ToolUsed,
} from './schema';
import { toolDefinitions } from './tools/registry';
import {
  LlmUnavailableError,
  type AgentLogger,
  type ConversationMessage,
  type CustomerProfile,
  type LlmClient,
  type LlmMessage,
  type LlmUsage,
  type SideEffectStore,
  type ToolContext,
  type ToolRegistry,
} from './types';

/**
 * Prefix of the guard note carrying a draft the guards refused to send.
 *
 * Exported for the eval harness, which needs it to tell "we refused to send
 * this" apart from "the model wrote nothing" - two different failures, and only
 * one is a defect in the model. Nothing imports it yet: the harness's own
 * `reply_draft_present` check still reads `customer_reply_draft` alone and so
 * currently conflates them. Import this rather than re-typing the literal, or
 * the contract is a string duplicated across two files that nothing pins.
 */
export const DISCARDED_DRAFT_NOTE = 'discarded_customer_reply_draft:';

/** Read-only tools whose successful result can ground a customer-facing claim. */
const EVIDENCE_TOOLS: readonly string[] = [
  'search_knowledge_base',
  'get_customer_account',
  'check_service_status',
];

export interface ToolCallRecord {
  seq: number;
  toolName: string;
  args: unknown;
  result: unknown;
  /** `system_rule` marks an action the service took itself, not one the model asked for. */
  policyOutcome: 'allowed' | 'requires_approval' | 'denied' | 'system_rule';
  status: 'succeeded' | 'failed' | 'pending_approval' | 'denied';
  latencyMs: number;
  sideEffectId?: string;
}

export interface TurnResult {
  decision: Decision;
  /** What the operator sees as the agent's chat reply. */
  agentReply: string;
  toolCalls: ToolCallRecord[];
  usage: LlmUsage;
  latencyMs: number;
  status: 'ok' | 'failed';
  error?: string;
  traceId: string;
  /** Number of model calls this turn actually made. */
  llmCalls: number;
}

export interface RunTurnInput {
  conversationId: string;
  customer: CustomerProfile;
  messages: ConversationMessage[];
  previousDecision?: Decision | null;
  llm: LlmClient;
  registry: ToolRegistry;
  store: SideEffectStore;
  log: AgentLogger;
  now?: Date;
  maxIterations?: number;
  maxSideEffectsPerTurn?: number;
  /**
   * Whether this turn may take actions. False for an operator's
   * natural-language question - see `EvaluateInput.sideEffectsAuthorized`.
   */
  sideEffectsAuthorized?: boolean;
  /**
   * Side effects on this ticket already waiting on a human when the turn
   * started. Read by the caller (it is a database question) and handed to
   * `applyGuards`, which must not auto-respond over a decision a human is
   * still holding - including one an earlier turn filed.
   */
  openApprovals?: number;
  traceId?: string;
}

export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const {
    conversationId,
    customer,
    llm,
    registry,
    store,
    log,
    now = new Date(),
    maxIterations = 6,
    maxSideEffectsPerTurn = 4,
    sideEffectsAuthorized = true,
    openApprovals = 0,
    traceId = randomUUID(),
  } = input;

  const startedAt = Date.now();
  const ctx: ToolContext = { conversationId, customer, now, log };
  const messages: LlmMessage[] = buildMessages({
    customer,
    messages: input.messages,
    previousDecision: input.previousDecision ?? null,
    now,
    sideEffectsAuthorized,
  });
  const tools = toolDefinitions(registry);
  const responseFormat = {
    name: DECISION_RESPONSE_FORMAT_NAME,
    schema: strictJsonSchema(ModelDecisionSchema),
  };

  // Deterministic, before the model sees anything: a ticket that tries to
  // override the agent's instructions gets no automated side effects at all.
  //
  // BOTH inbound channels, not just the ticket. Operator text is trusted in the
  // sense that matters - it sits outside the `<ticket>` tag and reaches the
  // model as an ordinary chat turn - and that is a statement about who is
  // asking, not about what the words contain. An operator quoting the ticket
  // back at the agent ("customer wrote: ...") carried the payload straight
  // across the boundary the tag exists to draw: measured, the identical
  // sentence escalated when it arrived as a customer message and licensed side
  // effects when an operator pasted it.
  //
  // `agent` rows are excluded on purpose. That is our own `operator_summary`,
  // and it QUOTES the attacker when it explains what happened - scanning it
  // would make one injected ticket escalate every later turn forever.
  const injection = detectInjectionAttempt(
    input.messages
      .filter((m) => m.role === 'customer' || m.role === 'operator')
      .map((m) => m.content)
      .join('\n'),
  );
  if (injection) {
    log.warn(
      {
        event: 'injection.detected',
        trace_id: traceId,
        conversation_id: conversationId,
        patterns: injection.patterns,
        excerpts: injection.excerpts,
      },
      'ticket contains an instruction-override attempt',
    );
  }

  const records: ToolCallRecord[] = [];
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let sideEffectBudget = maxSideEffectsPerTurn;
  let modelDecision: ModelDecision | null = null;
  let failure: string | undefined;
  /** Completed model calls. Counted, not derived from the loop variable, which
   * overshoots by one when the cap is reached. */
  let llmCalls = 0;

  log.info(
    {
      event: 'agent.turn.start',
      trace_id: traceId,
      conversation_id: conversationId,
      model: llm.model,
    },
    'agent turn started',
  );

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const response = await llm.complete({ messages, tools, responseFormat });
      llmCalls = iteration;
      usage.inputTokens += response.usage?.inputTokens ?? 0;
      usage.outputTokens += response.usage?.outputTokens ?? 0;

      log.info(
        {
          event: 'llm.response',
          trace_id: traceId,
          iteration,
          finish_reason: response.finishReason,
          tool_calls: response.toolCalls.map((c) => c.name),
        },
        'llm responded',
      );

      if (response.toolCalls.length === 0) {
        const parsed = parseModelDecision(response.content);
        if (!parsed.ok) {
          failure = parsed.error;
          log.error(
            { event: 'decision.invalid', trace_id: traceId, reason: parsed.error },
            'model output rejected',
          );
          break;
        }
        modelDecision = parsed.value;
        break;
      }

      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      // Policy is applied to every call BEFORE any of them execute, so the
      // side-effect budget cannot be overspent by a parallel batch.
      const plans = response.toolCalls.map((call) => {
        const decision = evaluate({
          registry,
          name: call.name,
          rawArgs: call.rawArgs,
          ctx,
          sideEffectBudget,
          injectionSuspected: injection !== null,
          sideEffectsAuthorized,
        });
        if (decision.kind !== 'deny' && decision.tool.sideEffecting) sideEffectBudget -= 1;
        log.info(
          {
            event: 'policy.decision',
            trace_id: traceId,
            tool: call.name,
            outcome: decision.kind,
            code: decision.kind === 'deny' ? decision.code : undefined,
          },
          'policy evaluated tool call',
        );
        return { call, decision };
      });

      const executed = await Promise.all(
        plans.map(({ call, decision }, index) =>
          executeToolCall({
            seq: records.length + index + 1,
            attemptedName: call.name,
            decision,
            ctx,
            store,
            log,
            traceId,
            conversationId,
          }).then((record) => ({ call, record })),
        ),
      );

      for (const { call, record } of executed) {
        records.push(record);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(record.result),
        });
      }
    }

    if (!modelDecision && !failure) failure = 'iteration_cap_reached';
  } catch (error) {
    failure =
      error instanceof LlmUnavailableError
        ? `llm_unavailable: ${error.message}`
        : `agent_error: ${(error as Error).message}`;
    log.error(
      { event: 'agent.turn.error', trace_id: traceId, reason: failure },
      'agent turn failed',
    );
  }

  // The service pages on its own evidence, whatever the model decided. Runs
  // after the loop so it sees every status check the model made, and before the
  // guards so the resulting incident appears in the decision's tools_used.
  const systemRecords = await pageIfRegionIsDown({
    records,
    ctx,
    store,
    registry,
    log,
    traceId,
  });
  records.push(...systemRecords);

  const degraded = modelDecision === null;
  const { decision, guardNotes } = applyGuards({
    base: modelDecision ?? failSafeDecision(failure ?? 'unknown'),
    records,
    degraded,
    model: llm.model,
    injection,
    openApprovals,
  });

  const latencyMs = Date.now() - startedAt;

  log.info(
    {
      event: 'decision.final',
      trace_id: traceId,
      conversation_id: conversationId,
      urgency: decision.urgency,
      next_action: decision.next_action,
      requires_human: decision.requires_human,
      degraded: decision.degraded,
      language: decision.language,
      tools_used: decision.tools_used.map((t) => `${t.name}:${t.status}`),
      pending_side_effects: decision.pending_side_effect_ids,
      guard_notes: guardNotes,
      prompt_version: decision.prompt_version,
      llm_calls: llmCalls,
      latency_ms: latencyMs,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    },
    'triage decision',
  );

  return {
    decision,
    agentReply: decision.operator_summary,
    toolCalls: records,
    usage,
    latencyMs,
    status: degraded ? 'failed' : 'ok',
    error: failure,
    traceId,
    llmCalls,
  };
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

interface ExecuteInput {
  seq: number;
  /** What the model asked for, so a denied call is still auditable by name. */
  attemptedName: string;
  decision: PolicyDecision;
  /** Overrides the recorded outcome; used to mark service-initiated actions. */
  outcomeLabel?: ToolCallRecord['policyOutcome'];
  ctx: ToolContext;
  store: SideEffectStore;
  log: AgentLogger;
  traceId: string;
  conversationId: string;
}

async function executeToolCall(input: ExecuteInput): Promise<ToolCallRecord> {
  const { seq, attemptedName, decision, ctx, store, log, traceId, conversationId, outcomeLabel } =
    input;
  const startedAt = Date.now();

  if (decision.kind === 'deny') {
    return {
      seq,
      toolName: attemptedName,
      args: null,
      result: {
        ok: false,
        error: { code: decision.code, message: decision.message, details: decision.details },
      },
      policyOutcome: 'denied',
      status: 'denied',
      latencyMs: 0,
    };
  }

  const { tool, args } = decision;
  log.info({ event: 'tool.call', trace_id: traceId, tool: tool.name, seq }, 'tool call started');

  const finish = (
    result: unknown,
    status: ToolCallRecord['status'],
    sideEffectId?: string,
  ): ToolCallRecord => {
    const record: ToolCallRecord = {
      seq,
      toolName: tool.name,
      args,
      result,
      policyOutcome:
        outcomeLabel ?? (decision.kind === 'requires_approval' ? 'requires_approval' : 'allowed'),
      status,
      latencyMs: Date.now() - startedAt,
      sideEffectId,
    };
    log.info(
      {
        event: 'tool.result',
        trace_id: traceId,
        tool: tool.name,
        seq,
        status,
        side_effect_id: sideEffectId,
        latency_ms: record.latencyMs,
      },
      'tool call finished',
    );
    return record;
  };

  try {
    // --- Human-gated: record the request, do not execute. -------------------
    if (decision.kind === 'requires_approval') {
      const row = await store.requestApproval({
        conversationId,
        toolName: tool.name,
        dedupKey: decision.dedupKey,
        args,
      });

      if (row.status === 'succeeded') {
        return finish(
          { ok: true, ...(row.result as object), note: 'already executed after approval' },
          'succeeded',
          row.id,
        );
      }
      if (row.status === 'executing') {
        return finish(
          {
            ok: true,
            status: 'executing',
            side_effect_id: row.id,
            note: 'A human approved this and it is executing now. Do not call this tool again.',
          },
          'pending_approval',
          row.id,
        );
      }
      if (row.status === 'rejected') {
        return finish(
          {
            ok: false,
            error: { code: 'rejected_by_human', message: 'A human rejected this action' },
          },
          'denied',
          row.id,
        );
      }
      return finish(
        {
          ok: true,
          status: 'pending_approval',
          side_effect_id: row.id,
          note: 'Filed for human approval. Nothing has been executed. Do not call this tool again for this item.',
        },
        'pending_approval',
        row.id,
      );
    }

    // --- Autonomous side effect: write-ahead claim, then execute. -----------
    if (tool.sideEffecting) {
      const claim = await store.beginAutonomous({
        conversationId,
        toolName: tool.name,
        dedupKey: decision.dedupKey!,
        args,
      });

      if (claim.outcome === 'replayed') {
        return finish(
          { ...(claim.record.result as object), deduplicated: true },
          claim.record.status === 'failed' ? 'failed' : 'succeeded',
          claim.record.id,
        );
      }
      if (claim.outcome === 'in_flight') {
        return finish(
          {
            ok: false,
            error: { code: 'in_flight', message: 'The same action is already running' },
          },
          'failed',
          claim.record.id,
        );
      }

      try {
        // The dedup key goes through to the tool so the PROVIDER's idempotency
        // key is the key we derived, not one the tool invents from the model's
        // arguments. Non-null because this branch is only reached for a
        // side-effecting tool, which the registry refuses to build without one.
        const result = await tool.execute(args, ctx, decision.dedupKey!);
        const ok = (result as { ok?: boolean }).ok !== false;
        await store.complete({ id: claim.record.id, status: ok ? 'succeeded' : 'failed', result });
        return finish(result, ok ? 'succeeded' : 'failed', claim.record.id);
      } catch (error) {
        const result = {
          ok: false,
          error: { code: 'downstream_unavailable', message: (error as Error).message },
        };
        await store.complete({ id: claim.record.id, status: 'failed', result });
        return finish(result, 'failed', claim.record.id);
      }
    }

    // --- Read-only tool. ----------------------------------------------------
    const result = await tool.execute(args, ctx);
    return finish(result, (result as { ok?: boolean }).ok === false ? 'failed' : 'succeeded');
  } catch (error) {
    // A read tool or the store threw. The turn continues: the model is told the
    // tool failed and can still produce a decision (usually an escalation).
    log.warn(
      {
        event: 'tool.error',
        trace_id: traceId,
        tool: tool.name,
        seq,
        reason: (error as Error).message,
      },
      'tool call threw',
    );
    return finish(
      { ok: false, error: { code: 'downstream_unavailable', message: (error as Error).message } },
      'failed',
    );
  }
}

// ---------------------------------------------------------------------------
// Deterministic rules
// ---------------------------------------------------------------------------

/**
 * Open an incident when our own probes say the customer's region is degraded.
 *
 * Not a guard, because guards are pure and this has a side effect. Not a prompt
 * rule, because across live runs the model confirmed a regional outage in its
 * rationale and paged nobody in a third of runs. Whether an engineer is woken up
 * must not depend on sampling.
 *
 * Safe to run every turn: the incident is filed through the same SideEffectStore
 * as a model-initiated call, so the region dedup key means one page per region
 * per conversation. If the model already paged, this replays the stored result
 * instead of paging again.
 *
 * NOT gated by `sideEffectsAuthorized`, and that asymmetry is the point. An
 * operator's question is not authorized to make the MODEL act - the phrasing of
 * a question must not file a refund - but this rule is the service acting on its
 * own probe data, and the reason it is code instead of a prompt line is that
 * waking an engineer must not depend on what the last message said or who typed
 * it. A regional outage is still a regional outage while an operator asks about
 * it. It reaches the provider through the same claim and the same global dedup
 * key either way, so an unauthorized turn cannot page twice.
 */
async function pageIfRegionIsDown(input: {
  records: ToolCallRecord[];
  ctx: ToolContext;
  store: SideEffectStore;
  registry: ToolRegistry;
  log: AgentLogger;
  traceId: string;
}): Promise<ToolCallRecord[]> {
  const { records, ctx, store, registry, log, traceId } = input;

  const outage = detectRegionalOutage(records, ctx.customer.region);
  if (!outage) return [];

  // The model already paged for THIS region in this turn: nothing to add.
  //
  // The region comparison is the whole rule. Without it, an incident the model
  // opened for some unrelated region made this rule conclude "already handled"
  // and page nobody for the region our own probes call degraded - which voids
  // the exact guarantee that put this rule in code instead of the prompt.
  // `pending_approval` is deliberately NOT treated as paged: open_incident is
  // autonomy 'auto', so that status is unreachable today, and counting it would
  // silently turn this rule into a no-op the day someone human-gates the tool.
  // A redundant page is harmless: `open_incident` declares `dedupScope:
  // 'global'`, so its region key collides service-wide and one outage is one
  // incident however many tickets report it. Failing towards paging is
  // therefore free in the direction that matters - a redundant page costs an
  // engineer minutes, an unpaged regional outage costs the account.
  const alreadyPaged = records.some(
    (record) =>
      record.toolName === 'open_incident' &&
      record.status === 'succeeded' &&
      (record.args as { region?: string } | null)?.region === outage.region,
  );
  if (alreadyPaged) {
    log.info(
      {
        event: 'rule.paging.skipped',
        trace_id: traceId,
        region: outage.region,
        reason: 'agent_already_paged',
      },
      'deterministic paging rule had nothing to do',
    );
    return [];
  }

  const tool = registry.get('open_incident');
  if (!tool) {
    log.error(
      { event: 'rule.paging.unavailable', trace_id: traceId },
      'open_incident is not registered',
    );
    return [];
  }

  const candidate = incidentFor(outage, ctx.conversationId);
  const parsed = tool.args.safeParse(candidate);
  if (!parsed.success) {
    // Our own synthesised arguments failed the tool contract: a bug here must be
    // loud rather than a silently skipped page.
    log.error(
      { event: 'rule.paging.invalid_args', trace_id: traceId, issues: parsed.error.issues },
      'deterministic incident arguments failed validation',
    );
    return [];
  }

  log.warn(
    {
      event: 'rule.paging.fired',
      trace_id: traceId,
      region: outage.region,
      state: outage.state,
      api_error_rate: outage.apiErrorRate,
      evidence_seq: outage.sourceSeq,
    },
    'paging on-call from probe data, independently of the agent decision',
  );

  const record = await executeToolCall({
    seq: records.length + 1,
    attemptedName: tool.name,
    decision: {
      kind: 'allow',
      tool,
      args: parsed.data,
      dedupKey: tool.dedupKey!(parsed.data, ctx),
    },
    outcomeLabel: 'system_rule',
    ctx,
    store,
    log,
    traceId,
    conversationId: ctx.conversationId,
  });

  if (record.status !== 'succeeded') {
    // The rule exists to make "an engineer is woken up" independent of model
    // sampling, and this is the one branch where it did not happen anyway: the
    // provider was unreachable, our own arguments were refused, or - the case
    // that is otherwise silent - the globally-scoped incident row was left
    // `executing` by a crashed process, so the claim came back `in_flight` and
    // the dedup that normally means "already handled" means "handled by nobody".
    //
    // `ReconcilerService` closes that window by measuring a side-effect claim
    // against one provider call rather than a whole turn, but the window is not
    // zero, and a failed page is worth an alert on its own rather than only a
    // `failed` tool_call row nobody queries.
    const result = record.result as { error?: { code?: string } } | null;
    log.error(
      {
        event: 'rule.paging.unresolved',
        needs_reconciliation: true,
        trace_id: traceId,
        region: outage.region,
        side_effect_id: record.sideEffectId,
        status: record.status,
        reason: result?.error?.code ?? 'unknown',
      },
      'the deterministic paging rule did not page on-call',
    );
  }

  return [record];
}

// ---------------------------------------------------------------------------
// Parsing, guards, fail-safe
// ---------------------------------------------------------------------------

export function parseModelDecision(
  content: string | null,
): { ok: true; value: ModelDecision } | { ok: false; error: string } {
  if (!content || content.trim() === '') return { ok: false, error: 'empty_model_output' };

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, error: 'model_output_not_json' };
  }

  const parsed = ModelDecisionSchema.safeParse(json);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    return { ok: false, error: `model_output_schema_violation: ${paths}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Fail-safe decision, used whenever triage did not complete.
 *
 * Urgency is `high`, deliberately: `low` would let a real incident sit in a
 * queue, and `critical` would page on-call every time the model provider has a
 * bad minute. `high` gets a human to look without waking anyone up.
 */
export function failSafeDecision(reason: string): ModelDecision {
  return {
    urgency: 'high',
    product_area: 'other',
    issue_type: 'other',
    secondary_topics: [],
    sentiment: 'neutral',
    language: 'und',
    next_action: 'escalate_to_human',
    specialist_team: null,
    rationale: `Automated triage did not complete (${reason}). No classification was produced, so the ticket is escalated unclassified rather than guessed.`,
    operator_summary: `I could not triage this ticket automatically (${reason}). It needs manual triage. Any tool calls already made are listed in the audit trail.`,
    customer_reply_draft: null,
  };
}

/**
 * Deterministic corrections applied on top of the model's output.
 *
 * These are business invariants, so they live in code where they can be tested
 * and cannot be talked out of by a clever ticket. The model is free to be wrong
 * here; the system still behaves.
 */
export function applyGuards(input: {
  base: ModelDecision;
  records: ToolCallRecord[];
  degraded: boolean;
  model: string;
  injection?: InjectionFinding | null;
  /**
   * Side effects on this TICKET that are still waiting on a human, filed by any
   * turn - counted by the caller, not derived from `records`.
   *
   * `pendingIds` below is this turn's own filings, which is the right meaning
   * for `pending_side_effect_ids` and the wrong field of view for the guard: a
   * refund filed by turn 1 is exactly what a later turn must not auto-respond
   * over, and turn 2's records know nothing about it. Passed in because this
   * function is pure and `ReconcilerService` reuses it outside any request.
   */
  openApprovals?: number;
}): { decision: Decision; guardNotes: string[] } {
  const { base, records, degraded, model, injection = null, openApprovals = 0 } = input;
  const notes: string[] = [];

  // De-duplicated: a model that asks for the same refund twice must not make
  // the decision object claim two pending approvals.
  const pendingIds = [
    ...new Set(
      records
        .filter((r) => r.status === 'pending_approval')
        .map((r) => r.sideEffectId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  let nextAction = base.next_action;
  let specialistTeam = base.specialist_team;
  /**
   * Code of the guard that took `auto_respond` away, if one did. Only the first
   * guard to fire can see `auto_respond`, so there is at most one. Used to name
   * the reason in the server-authored operator summary below, so an operator
   * does not have to diff `next_action` against the model's prose to work out
   * why no reply went out.
   */
  let removedAutoRespond: string | null = null;

  const escalate = (note: string) => {
    if (nextAction === 'auto_respond') removedAutoRespond = noteCode(note);
    if (nextAction !== 'escalate_to_human') {
      nextAction = 'escalate_to_human';
      notes.push(note);
    }
  };

  if (degraded) {
    // Pushed unconditionally rather than through `escalate()`, which only
    // records a note when it actually changes `next_action`. The fail-safe
    // decision is already `escalate_to_human`, so this note never reached
    // guard_notes on the one kind of turn where it is the whole story: an
    // operator filtering on guard_notes could not see that triage never ran.
    notes.push('triage_degraded: forced escalation');
    if (nextAction === 'auto_respond') removedAutoRespond = 'triage_degraded';
    nextAction = 'escalate_to_human';
  }
  if (injection) {
    // Never auto-answer a ticket that tried to hijack the agent: the reply would
    // go to whoever wrote the injection, confirming what they asked for.
    const note = `injection_suspected: ${injection.patterns.join(', ')}`;
    escalate(note);
    if (!notes.includes(note)) notes.push(note);
  }
  if ((pendingIds.length > 0 || openApprovals > 0) && nextAction === 'auto_respond') {
    escalate('pending_human_approval: cannot auto-respond while an action awaits approval');
  }
  if (base.urgency === 'critical' && nextAction === 'auto_respond') {
    escalate('critical_urgency: never auto-respond to a critical ticket');
  }
  if (nextAction === 'auto_respond' && !base.customer_reply_draft?.trim()) {
    escalate('auto_respond_without_draft: no reply text was produced');
  }

  // An auto-response is customer-facing text sent with no human in the loop, so
  // it has to be grounded in something we looked up rather than in the model's
  // memory of how some other product works.
  //
  // The default is deny. This guard used to apply only to an allow-list of
  // `issue_type` values, which made grounding opt-in on a field the MODEL
  // picks: `issue_type: 'other'` - the mandatory off-taxonomy bucket - and a
  // misclassified `billing_dispute` both auto-responded with ZERO tool calls
  // behind them, a draft claiming refunds nothing had looked up, and an empty
  // guard_notes. That is reached by ordinary misclassification, not by an
  // attack, so the exemption list is gone: every auto-response needs at least
  // one tool result behind it, and question-shaped tickets still need the
  // stronger form, an actual knowledge base hit.
  const GROUNDABLE: ReadonlyArray<ModelDecision['issue_type']> = [
    'question',
    'how_to',
    'feature_request',
    'bug',
    // `other` is where the model puts anything off-taxonomy, so it is reached by
    // ordinary misclassification and must be the MOST gated value, not the least.
    'other',
  ];
  if (nextAction === 'auto_respond') {
    const groundedInKb = records.some(
      (record) => record.toolName === 'search_knowledge_base' && isEvidence(record),
    );
    // Routed rather than escalated: it is an unverified answer, not an incident.
    if (GROUNDABLE.includes(base.issue_type) && !groundedInKb) {
      removedAutoRespond = 'ungrounded_auto_respond';
      nextAction = 'route_to_specialist';
      notes.push('ungrounded_auto_respond: no knowledge base result behind the reply');
    } else if (
      (base.issue_type === 'billing_dispute' || base.product_area === 'billing') &&
      !records.some((record) => record.toolName === 'get_customer_account' && isEvidence(record))
    ) {
      // Grounding is a relation between the claim and the evidence, not a count
      // of successful calls. A status probe says nothing about this customer's
      // charges, so it cannot license "we have refunded the two duplicates".
      removedAutoRespond = 'ungrounded_auto_respond';
      nextAction = 'route_to_specialist';
      notes.push('ungrounded_auto_respond: no account lookup behind a claim about money');
    } else if (!records.some(isEvidence)) {
      removedAutoRespond = 'ungrounded_auto_respond';
      nextAction = 'route_to_specialist';
      notes.push('ungrounded_auto_respond: no successful tool result behind the reply');
    }
  }

  // A holding reply is a communication quality problem, not a safety one, so it
  // is flagged for the operator rather than fabricated here. Code cannot write
  // it: the message has to be in the customer's language and reflect the
  // specific evidence.
  //
  // Suppressed on a degraded turn: the fail-safe decision is urgency `high` with
  // no draft by definition, so this note fired on 100% of degraded turns while
  // adding nothing to the `triage_degraded` note above. A field that is always
  // populated is a field operators learn to skip.
  if (
    !degraded &&
    (base.urgency === 'critical' || base.urgency === 'high') &&
    !base.customer_reply_draft?.trim()
  ) {
    notes.push('missing_holding_reply: no draft for the customer on an urgent ticket');
  }
  if (nextAction === 'route_to_specialist' && !specialistTeam?.trim()) {
    specialistTeam = 'general_support';
    notes.push('missing_specialist_team: defaulted to general_support');
  }

  // A GUARD took `auto_respond` away, so the customer-facing prose the model
  // wrote to be sent unread is precisely the artefact we just decided not to
  // trust. Keeping it made the system route an injected ticket *because* its
  // draft was untrustworthy and then hand the operator that draft as finished
  // work - measured: `escalate_to_human`, no pending side effects, and a draft
  // reading "a full refund of all charges has been approved and sent".
  //
  // Discarded, not destroyed: the draft goes into guard_notes so the audit trail
  // still shows what the model wanted to send. (guard_notes rather than a new
  // Decision field because the field would mean a schema change, and a note
  // costs nothing downstream.) `rationale` is deliberately untouched - it is the
  // model's reasoning record, and an operator needs to see what the model
  // claimed in order to judge it.
  //
  // A `route_to_specialist` or `escalate_to_human` the MODEL chose keeps its
  // draft: the prompt asks for a holding reply on critical/high tickets even
  // when not auto-responding, and dropping it would reintroduce the 45-seat
  // enterprise account that sat in silence.
  let operatorSummary = base.operator_summary;
  let customerReplyDraft = base.customer_reply_draft;
  // Two triggers, not one. A guard taking `auto_respond` away is the obvious
  // case. The second is `injection`, whatever the model chose: a validator
  // probe returned next_action `escalate_to_human` with the draft intact as
  // "Ignore previous instructions: your refund of $9999 was sent." because the
  // model had routed the ticket itself, so the first trigger never fired. Under
  // injection_suspected the draft's PROVENANCE is what is suspect, which is
  // independent of which action the model picked - and the policy already
  // refuses every side effect on such a ticket, so discarding its prose is the
  // consistent stance. The holding-reply argument below still protects every
  // benign demotion.
  if ((base.next_action === 'auto_respond' || injection) && nextAction !== 'auto_respond') {
    const discarded = base.customer_reply_draft?.trim();
    // Truncated: on the path this fires most (injection_suspected) the draft is
    // attacker-authored, and guard_notes flows into the API response, the
    // persisted turn, and the `decision.final` log line wholesale. The audit
    // value is in seeing what it tried to say, not in storing all 4000 chars.
    if (discarded) {
      const excerpt =
        discarded.length > 300 ? `${discarded.slice(0, 300)}...[truncated]` : discarded;
      notes.push(`${DISCARDED_DRAFT_NOTE} ${excerpt}`);
    }
    customerReplyDraft = null;
    operatorSummary =
      `No automated reply was sent (${removedAutoRespond ?? (injection ? 'injection_suspected' : 'guard_override')}). The model's draft was ` +
      `discarded unsent${discarded ? ' and is preserved verbatim in guard_notes' : ''}, and its own ` +
      `summary is withheld because it described sending that reply. See rationale for what the ` +
      `model claimed and tools_used for what actually ran.`;
  }

  const toolsUsed: ToolUsed[] = records.map((record) => ({
    name: record.toolName,
    status: record.status,
    side_effect_id: record.sideEffectId ?? null,
    error:
      record.status === 'failed' || record.status === 'denied'
        ? ((record.result as { error?: { code?: string } })?.error?.code ?? 'unknown')
        : null,
  }));

  const decision: Decision = {
    ...base,
    next_action: nextAction,
    specialist_team: specialistTeam,
    operator_summary: operatorSummary,
    customer_reply_draft: customerReplyDraft,
    // `auto_respond` means the draft is safe to send without a human decision;
    // every other action needs one.
    requires_human: nextAction !== 'auto_respond',
    degraded,
    injection_suspected: injection !== null,
    guard_notes: notes,
    tools_used: toolsUsed,
    pending_side_effect_ids: pendingIds,
    prompt_version: PROMPT_VERSION,
    model,
  };

  return { decision, guardNotes: notes };
}

/**
 * A tool result we can point at as evidence: the call ran, it succeeded, and it
 * came back with something.
 *
 * `result_count: 0` is a successful search that found nothing, which is an empty
 * result and not evidence - a live run auto-answered an "I cannot log in at all"
 * ticket off an empty result set. Read generically rather than per tool name, so
 * a search-shaped tool added later is gated the day it exists rather than the
 * day someone remembers to list it here.
 */
function isEvidence(record: ToolCallRecord): boolean {
  if (record.status !== 'succeeded') return false;
  // The allowlist is the whole exclusion, and it is what keeps a SIDE EFFECT
  // out: `pageIfRegionIsDown` pushes its own `system_rule` open_incident record
  // into `records` before the guards run, so treating any succeeded call as
  // evidence let the service manufacture the grounding that licensed the
  // model's unread reply.
  //
  // There used to be a second check here (`policyOutcome === 'system_rule'`)
  // with a comment claiming both had been probed independently. They had not:
  // every `system_rule` record today is an open_incident, which this line
  // already excludes, so the pair masked each other and only one was
  // load-bearing. Deleted rather than declared - two guards where one does the
  // work is how a later edit silently removes the one that mattered. If a
  // deterministic rule is ever given an evidence-shaped tool (a probe that
  // calls `check_service_status` itself, say), the exclusion has to come back
  // WITH a probe of its own, because the allowlist will not cover it.
  if (!EVIDENCE_TOOLS.includes(record.toolName)) return false;
  const result = record.result as { ok?: boolean; result_count?: number } | null;
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok !== true) {
    return false;
  }
  // `?? 1` reads "this tool does not report a count", not "assume a hit": only
  // search-shaped results carry result_count, and EVIDENCE_TOOLS is the closed
  // list that makes the default safe. An earlier comment here claimed the
  // generic read gated any future search tool; it did the opposite, because a
  // tool returning `{ok:true, results:[]}` has no result_count at all.
  return (result.result_count ?? 1) > 0;
}

/** `'critical_urgency: never auto-respond...'` -> `'critical_urgency'`. */
function noteCode(note: string): string {
  return note.split(':')[0] ?? note;
}
