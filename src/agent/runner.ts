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
    traceId = randomUUID(),
  } = input;

  const startedAt = Date.now();
  const ctx: ToolContext = { conversationId, customer, now, log };
  const messages: LlmMessage[] = buildMessages({
    customer,
    messages: input.messages,
    previousDecision: input.previousDecision ?? null,
    now,
  });
  const tools = toolDefinitions(registry);
  const responseFormat = {
    name: DECISION_RESPONSE_FORMAT_NAME,
    schema: strictJsonSchema(ModelDecisionSchema),
  };

  // Deterministic, before the model sees anything: a ticket that tries to
  // override the agent's instructions gets no automated side effects at all.
  const injection = detectInjectionAttempt(
    input.messages.filter((m) => m.role === 'customer').map((m) => m.content).join('\n'),
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
    { event: 'agent.turn.start', trace_id: traceId, conversation_id: conversationId, model: llm.model },
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
          log.error({ event: 'decision.invalid', trace_id: traceId, reason: parsed.error }, 'model output rejected');
          break;
        }
        modelDecision = parsed.value;
        break;
      }

      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

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
    log.error({ event: 'agent.turn.error', trace_id: traceId, reason: failure }, 'agent turn failed');
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
      result: { ok: false, error: { code: decision.code, message: decision.message, details: decision.details } },
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
        return finish({ ok: true, ...(row.result as object), note: 'already executed after approval' }, 'succeeded', row.id);
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
          { ok: false, error: { code: 'rejected_by_human', message: 'A human rejected this action' } },
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
          { ok: false, error: { code: 'in_flight', message: 'The same action is already running' } },
          'failed',
          claim.record.id,
        );
      }

      try {
        const result = await tool.execute(args, ctx);
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
      { event: 'tool.error', trace_id: traceId, tool: tool.name, seq, reason: (error as Error).message },
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

  // The model already paged for this region in this turn: nothing to add.
  const alreadyPaged = records.some(
    (record) =>
      record.toolName === 'open_incident' &&
      (record.status === 'succeeded' || record.status === 'pending_approval'),
  );
  if (alreadyPaged) {
    log.info(
      { event: 'rule.paging.skipped', trace_id: traceId, region: outage.region, reason: 'agent_already_paged' },
      'deterministic paging rule had nothing to do',
    );
    return [];
  }

  const tool = registry.get('open_incident');
  if (!tool) {
    log.error({ event: 'rule.paging.unavailable', trace_id: traceId }, 'open_incident is not registered');
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
}): { decision: Decision; guardNotes: string[] } {
  const { base, records, degraded, model, injection = null } = input;
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

  const escalate = (note: string) => {
    if (nextAction !== 'escalate_to_human') {
      nextAction = 'escalate_to_human';
      notes.push(note);
    }
  };

  if (degraded) escalate('triage_degraded: forced escalation');
  if (injection) {
    // Never auto-answer a ticket that tried to hijack the agent: the reply would
    // go to whoever wrote the injection, confirming what they asked for.
    escalate(`injection_suspected: ${injection.patterns.join(', ')}`);
    if (!notes.some((note) => note.startsWith('injection_suspected'))) {
      notes.push(`injection_suspected: ${injection.patterns.join(', ')}`);
    }
  }
  if (pendingIds.length > 0 && nextAction === 'auto_respond') {
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
  // memory of how some other product works. Only question-shaped tickets are
  // gated: a decision built from account or status data is already grounded.
  const GROUNDABLE: ReadonlyArray<ModelDecision['issue_type']> = [
    'question',
    'how_to',
    'feature_request',
    'bug',
  ];
  // A search that returned nothing is not grounding. The first version of this
  // guard only checked that a search happened, and a live run auto-answered a
  // "I cannot log in at all" ticket off an empty result set - which is exactly
  // the failure the prompt warns about and the guard was supposed to catch.
  const searchedKb = records.some(
    (record) =>
      record.toolName === 'search_knowledge_base' &&
      record.status === 'succeeded' &&
      ((record.result as { result_count?: number } | undefined)?.result_count ?? 0) > 0,
  );
  if (nextAction === 'auto_respond' && GROUNDABLE.includes(base.issue_type) && !searchedKb) {
    // Routed rather than escalated: it is an unverified answer, not an incident.
    nextAction = 'route_to_specialist';
    notes.push('ungrounded_auto_respond: no knowledge base result behind the reply');
  }

  // A holding reply is a communication quality problem, not a safety one, so it
  // is flagged for the operator rather than fabricated here. Code cannot write
  // it: the message has to be in the customer's language and reflect the
  // specific evidence.
  if (
    (base.urgency === 'critical' || base.urgency === 'high') &&
    !base.customer_reply_draft?.trim()
  ) {
    notes.push('missing_holding_reply: no draft for the customer on an urgent ticket');
  }
  if (nextAction === 'route_to_specialist' && !specialistTeam?.trim()) {
    specialistTeam = 'general_support';
    notes.push('missing_specialist_team: defaulted to general_support');
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
