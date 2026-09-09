/**
 * H. The three expiry-less leases, and the one pass that closes them.
 *
 * Three non-terminal statuses exit only if the process that entered them
 * survives to write the exit. Nothing ages them out, nothing lists them, and
 * two of the three are how a customer waits forever for a reply nobody knows
 * they are owed:
 *
 *  - H1/H2  `side_effects.status = 'executing'`. A crash between the provider
 *           call and the write that records its result. Money may have moved
 *           and `refund_id` is the only handle on it.
 *  - H3     `agent_turns.status = 'running'`. An aborted request leaves it
 *           forever: no reply, `conversation.status` unchanged, no endpoint
 *           that lists it. The ticket ROW survives, which is not the same as
 *           the ticket being handled.
 *  - H4/H5  `idempotency_keys.status = 'in_progress'`. A crash between the
 *           pre-handler insert and the post-handler update wedges that key at
 *           409 forever - the client that most needs the retry is refused. The
 *           table also never removes terminal rows.
 *
 * Every assertion drives `ReconcilerService.sweep()` directly. Waiting on the
 * production timer would make the whole file a race; H8 is the one test that
 * exercises the timer at all, and it stubs the pass.
 */
import type { LightMyRequestResponse } from 'fastify';
import { Logger } from 'nestjs-pino';

import type { ToolRegistry } from '../src/agent/types';
import { stableId } from '../src/agent/tools/support';
import { TOOL_REGISTRY } from '../src/triage/agent.providers';
import { decisionFixture } from '../src/agent/llm/fake';
import { ReconcilerService } from '../src/triage/reconciler.service';
import { createTestApp, truncateAll, ticket1, type TestApp } from './support/app';

const MINUTE = 60_000;

/** cust_1001's second real charge; ACCOUNTS says it is `succeeded` and refundable. */
const CHARGE = 'ch_3f22b';
const DEDUP_KEY = `cust_1001:${CHARGE}`;

const refundArgs = {
  charge_id: CHARGE,
  amount_cents: 2999,
  currency: 'USD',
  reason: 'duplicate charge for a failed upgrade',
};

describe('Reconciler: expiry for executing / running / in_progress (e2e)', () => {
  let ctx: TestApp;
  let reconciler: ReconcilerService;

  beforeAll(async () => {
    ctx = await createTestApp();
    reconciler = ctx.app.get(ReconcilerService);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.prisma);
  });

  const http = () => ctx.app.getHttpAdapter().getInstance();
  const post = (url: string, payload?: object, headers?: Record<string, string>) =>
    http().inject({ method: 'POST', url, payload, headers });
  const json = (res: LightMyRequestResponse) => JSON.parse(res.payload);

  const conversation = () =>
    ctx.prisma.conversation.create({
      data: {
        customer: {
          id: 'cust_1001',
          plan: 'free',
          tenure_months: 4,
          region: 'us-east-1',
          prior_tickets: 0,
        },
        status: 'open',
      },
    });

  /** A side effect committed as `executing` and then never completed. */
  const strandedSideEffect = async (input: {
    conversationId: string;
    ageMs: number;
    toolName?: string;
    args?: unknown;
    dedupKey?: string;
    dedupScopeKey?: string;
  }) => {
    const at = new Date(Date.now() - input.ageMs);
    return ctx.prisma.sideEffect.create({
      data: {
        conversationId: input.conversationId,
        // `issue_refund` is conversation-scoped, so its scope key IS the
        // conversation id. Set explicitly because these rows are inserted
        // directly rather than through the store, which would derive it.
        dedupScopeKey: input.dedupScopeKey ?? input.conversationId,
        toolName: input.toolName ?? 'issue_refund',
        dedupKey: input.dedupKey ?? DEDUP_KEY,
        status: 'executing',
        args: (input.args ?? refundArgs) as object,
        createdAt: at,
        updatedAt: at,
      },
    });
  };

  /** The arguments the deterministic paging rule synthesises for a degraded region. */
  const incidentArgs = (region: string) => ({
    severity: 'sev2',
    region,
    title: `Degraded region ${region}`,
    summary: `Probe data reports ${region} degraded; opened by the reconciler test.`,
  });

  /**
   * Wait until `count` turn rows exist on a conversation.
   *
   * A condition wait, not a sleep: `agent_turns` rows are created and committed
   * before the model call, so this is how a test says "all these requests have
   * really started" without racing HTTP against a direct `sweep()` call.
   */
  const untilTurnsOpen = async (conversationId: string, count: number) => {
    for (let i = 0; i < 500; i += 1) {
      if ((await ctx.prisma.agentTurn.count({ where: { conversationId } })) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`only ${count} turns never opened on ${conversationId}`);
  };

  const abandonedTurn = async (conversationId: string, ageMs: number) =>
    ctx.prisma.agentTurn.create({
      data: {
        conversationId,
        traceId: 'trace-abandoned',
        model: 'gpt-4.1-mini',
        promptVersion: 'v5',
        status: 'running',
        createdAt: new Date(Date.now() - ageMs),
      },
    });

  // -------------------------------------------------------------------------
  // H1/H2: side_effects.status = 'executing'
  // -------------------------------------------------------------------------

  it('H1: a stranded `executing` refund is re-driven and lands on the same refund_id', async () => {
    // The property the recovery leans on: every mock tool derives its result id
    // from the SERVER-derived dedup key (`stableId(prefix, dedupKey)` in
    // src/agent/tools/support.ts), exactly as a payment provider derives it from
    // an idempotency key. So re-driving the identical call cannot produce a
    // second refund and cannot produce a second id - it hands back the id the
    // crashed attempt lost. That is what makes automated recovery viable here
    // rather than a second charge.
    const conv = await conversation();
    const row = await strandedSideEffect({ conversationId: conv.id, ageMs: 30 * MINUTE });

    const report = await reconciler.sweep();

    expect(report.sideEffects.redriven).toEqual([row.id]);
    expect(report.sideEffects.quarantined).toEqual([]);

    const after = await ctx.prisma.sideEffect.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('succeeded');
    expect((after.result as { refund_id: string }).refund_id).toBe(stableId('re', DEDUP_KEY));
    expect((after.result as { charge_id: string }).charge_id).toBe(CHARGE);
  });

  it('H2: a stranded row whose stored args no longer validate is quarantined, not re-driven', async () => {
    // Never call a payment provider with arguments we cannot check. `args` came
    // out of a JSON column that may have been written by a previous deploy, and
    // this is the one path that moves money - so a row we cannot re-drive is
    // failed with a recorded reason for a human, which is something an operator
    // can act on. `executing` is something nobody can act on at all.
    const conv = await conversation();
    const row = await strandedSideEffect({
      conversationId: conv.id,
      ageMs: 30 * MINUTE,
      args: { charge_id: CHARGE }, // amount_cents / currency / reason gone
    });

    const report = await reconciler.sweep();

    expect(report.sideEffects.redriven).toEqual([]);
    expect(report.sideEffects.quarantined).toEqual([row.id]);

    const after = await ctx.prisma.sideEffect.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('failed');
    expect((after.result as { error: { code: string } }).error.code).toBe(
      'invalid_stored_arguments',
    );
  });

  it('H2d: an old `pending_approval` row is never executed by the sweep', async () => {
    // The worst thing this pass could possibly do. `pending_approval` is not a
    // lease - it is a row correctly waiting on a human, and humans take longer
    // than twelve minutes - so a sweeper that treated age as abandonment would
    // execute refunds with NO human in the loop, defeating the autonomy
    // boundary the whole service is built around.
    //
    // Two independent guards stop it: the scan filters on `status =
    // 'executing'`, and every write is a conditional UPDATE that also requires
    // `status = 'executing'`. Either alone suffices, which is why breaking just
    // one of them is not observable - so this test pins the PROPERTY, and the
    // report records the compound mutation that breaks both.
    const conv = await conversation();
    const pending = await ctx.prisma.sideEffect.create({
      data: {
        conversationId: conv.id,
        dedupScopeKey: conv.id,
        toolName: 'issue_refund',
        dedupKey: 'cust_1001:ch_3f23c',
        status: 'pending_approval',
        args: { ...refundArgs, charge_id: 'ch_3f23c' },
        createdAt: new Date(Date.now() - 3 * 24 * 3600_000),
        updatedAt: new Date(Date.now() - 3 * 24 * 3600_000),
      },
    });
    const settled = await ctx.prisma.sideEffect.create({
      data: {
        conversationId: conv.id,
        dedupScopeKey: conv.id,
        toolName: 'issue_refund',
        dedupKey: 'cust_1001:ch_3f21a',
        status: 'succeeded',
        args: { ...refundArgs, charge_id: 'ch_3f21a' },
        result: { ok: true, refund_id: 're_already_done' },
        createdAt: new Date(Date.now() - 3 * 24 * 3600_000),
        updatedAt: new Date(Date.now() - 3 * 24 * 3600_000),
      },
    });
    const stranded = await strandedSideEffect({ conversationId: conv.id, ageMs: 30 * MINUTE });

    const report = await reconciler.sweep();
    expect(report.sideEffects.redriven).toEqual([stranded.id]);

    const after = await ctx.prisma.sideEffect.findMany({
      where: { id: { in: [pending.id, settled.id] } },
    });
    expect(after.map((r) => r.status).sort()).toEqual(['pending_approval', 'succeeded']);
    // No money moved and no lease was renewed on either of them.
    for (const row of after) {
      expect(row.updatedAt.getTime()).toBeLessThan(Date.now() - 24 * 3600_000);
    }
    expect(after.find((r) => r.id === pending.id)!.result).toBeNull();
  });

  it('H1c: a side-effect claim is a lease on ONE call, not on a whole turn', async () => {
    // A `side_effects` claim is taken immediately before a single provider call
    // and released immediately after, so measuring it with the turn threshold
    // (12 minutes: model attempts x iterations x slack) overstated its lifetime
    // by an order of magnitude - and the claim holds a DEDUP KEY while it
    // stands. `open_incident` is globally scoped, so one row stranded by a
    // crash answers `in_flight` to every later ticket reporting the same
    // outage: nobody is paged, for as long as the threshold lasts.
    //
    // Two minutes old. Under the turn threshold, over the per-call one.
    const conv = await conversation();
    const row = await strandedSideEffect({
      conversationId: conv.id,
      ageMs: 2 * MINUTE,
      toolName: 'open_incident',
      dedupKey: 'asia-southeast-1',
      dedupScopeKey: 'global',
      args: incidentArgs('asia-southeast-1'),
    });
    // The turn lease is deliberately NOT shortened with it: this row is the
    // control that proves the split is a split and not a blanket cut, because
    // re-driving a live TURN hands a fail-safe decision to a running request.
    const turn = await abandonedTurn(conv.id, 2 * MINUTE);

    const report = await reconciler.sweep();

    expect(report.sideEffects.redriven).toEqual([row.id]);
    expect(report.turns.failedSafe).toEqual([]);

    const after = await ctx.prisma.sideEffect.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('succeeded');
    // The page the crashed attempt lost, on the same incident id a retry of it
    // would have produced.
    expect((after.result as { incident_id: string }).incident_id).toBe(
      stableId('inc', 'asia-southeast-1', 10),
    );
    expect((after.result as { paged: string[] }).paged).toEqual([
      'oncall-platform-asia-southeast-1',
    ]);
    expect((await ctx.prisma.agentTurn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe(
      'running',
    );
  });

  it('H1b: a lease renewed by another sweeper after our scan is not re-driven', async () => {
    // What the lease-renewal claim buys, tested deterministically rather than by
    // racing two `sweep()` calls in one process (which the event loop happily
    // serialises, so it discriminates nothing). The scan is fed the row as it
    // looked BEFORE another replica claimed it - the exact state a second
    // sweeper holds - and the conditional UPDATE on (status, updated_at) must
    // then find nothing.
    //
    // Losing this would not double-refund: the id is a pure function of the
    // dedup key. It would be a second provider call per replica per sweep,
    // which with N replicas all sweeping is routine, not rare.
    const conv = await conversation();
    const row = await strandedSideEffect({ conversationId: conv.id, ageMs: 30 * MINUTE });

    // Another sweeper renews the lease. `updated_at` moves; the row stays
    // `executing` because that is still the truth.
    await ctx.prisma.sideEffect.update({ where: { id: row.id }, data: { status: 'executing' } });

    const scan = jest
      .spyOn(ctx.prisma.sideEffect, 'findMany')
      .mockResolvedValueOnce([row] as never);
    let report: Awaited<ReturnType<typeof reconciler.sweep>>;
    try {
      report = await reconciler.sweep();
    } finally {
      scan.mockRestore();
    }

    expect(report.sideEffects.redriven).toEqual([]);
    expect(report.sideEffects.quarantined).toEqual([]);
    // The provider was never called: no result was recorded.
    expect(
      (await ctx.prisma.sideEffect.findUniqueOrThrow({ where: { id: row.id } })).result,
    ).toBeNull();
  });

  it('H1d: a re-drive that lost the row mid-call does not overwrite the recorded answer', async () => {
    // The other half of H1b. There, the sweeper loses the CLAIM before calling
    // the provider and never calls it. Here it wins the claim, calls the
    // provider, and while that call is in flight the request path - a human
    // approving the same refund - records the real answer.
    //
    // The sweeper's own attempt then comes back a transient failure, and an
    // unconditional final write would replace a succeeded refund with `failed`
    // and no refund_id: the stored result is the only copy of that id, so this
    // is the write that turns "we refunded them" into "we have no record of
    // refunding them" while the money is gone.
    const conv = await conversation();
    const row = await strandedSideEffect({ conversationId: conv.id, ageMs: 5 * MINUTE });

    const registry = ctx.app.get<ToolRegistry>(TOOL_REGISTRY);
    const refund = registry.get('issue_refund')!;
    const trueAnswer = {
      ok: true,
      refund_id: stableId('re', DEDUP_KEY),
      charge_id: CHARGE,
      status: 'pending_settlement',
    };
    const spy = jest.spyOn(refund, 'execute').mockImplementation(async () => {
      // The approving request settles the row while we are "at the provider".
      await ctx.prisma.sideEffect.update({
        where: { id: row.id },
        data: { status: 'succeeded', result: trueAnswer },
      });
      return { ok: false, error: { code: 'downstream_unavailable', message: 'gateway timeout' } };
    });

    let report: Awaited<ReturnType<typeof reconciler.sweep>>;
    try {
      report = await reconciler.sweep();
    } finally {
      spy.mockRestore();
    }

    // Not counted as re-driven: this pass produced no outcome that stuck.
    expect(report.sideEffects.redriven).toEqual([]);
    expect(report.sideEffects.quarantined).toEqual([]);

    const after = await ctx.prisma.sideEffect.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('succeeded');
    expect(after.result).toEqual(trueAnswer);
  });

  // -------------------------------------------------------------------------
  // H3: agent_turns.status = 'running'
  // -------------------------------------------------------------------------

  it('H3: an abandoned `running` turn reaches the SAME end state as a degraded turn', async () => {
    // Marking it `failed` and stopping would swap a silent loss for a slightly
    // less silent one. The runner's fail-safe decision - urgency `high`,
    // `escalate_to_human`, `degraded: true` - exists so a ticket lands in the
    // human queue, and it only does that if the reply and the conversation
    // status are written too.
    const conv = await conversation();
    await ctx.prisma.message.create({
      data: { conversationId: conv.id, seq: 1, role: 'customer', content: 'I was charged twice.' },
    });
    const turn = await abandonedTurn(conv.id, 30 * MINUTE);

    const report = await reconciler.sweep();
    expect(report.turns.failedSafe).toEqual([turn.id]);

    const after = await ctx.prisma.agentTurn.findUniqueOrThrow({ where: { id: turn.id } });
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/abandoned/);

    const decision = after.decision as Record<string, unknown>;
    expect(decision.urgency).toBe('high');
    expect(decision.next_action).toBe('escalate_to_human');
    expect(decision.requires_human).toBe(true);
    expect(decision.degraded).toBe(true);
    expect(decision.tools_used).toEqual([]);
    expect(decision.model).toBe('gpt-4.1-mini');
    expect(decision.guard_notes).toContain('triage_degraded: forced escalation');

    // The customer is owed a response and somebody now knows it.
    const conversationAfter = await ctx.prisma.conversation.findUniqueOrThrow({
      where: { id: conv.id },
    });
    expect(conversationAfter.status).toBe('awaiting_human');

    const messages = await ctx.prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { seq: 'asc' },
    });
    expect(messages.map((m) => m.role)).toEqual(['customer', 'agent']);
    expect(messages[1]?.content).toBe(decision.operator_summary);
  });

  it('H3c: an abandoned turn a LATER turn already answered is failed quietly', async () => {
    // H3's fail-safe end state - a second agent reply plus
    // `awaiting_human` - is right for a conversation still waiting on the turn
    // that died. It is wrong for one that has moved on.
    //
    // A turn aborts (client hangs up, container restart) and the operator
    // simply asks again; the second turn answers, replies, and leaves the
    // ticket wherever its own decision put it. Twelve minutes later the sweeper
    // finds turn one still `running` and, with no bound, appends a
    // contradicting reply after the real one and reopens the ticket into the
    // human queue on the strength of a turn nobody is waiting for any more.
    const conv = await conversation();
    await ctx.prisma.message.create({
      data: { conversationId: conv.id, seq: 1, role: 'customer', content: 'I was charged twice.' },
    });
    const abandoned = await abandonedTurn(conv.id, 30 * MINUTE);

    // The turn that actually answered: newer, terminal, with its own reply.
    const answered = await ctx.prisma.agentTurn.create({
      data: {
        conversationId: conv.id,
        traceId: 'trace-answered',
        model: 'gpt-4.1-mini',
        promptVersion: 'v5',
        status: 'ok',
        decision: { urgency: 'low', next_action: 'auto_respond', requires_human: false },
        createdAt: new Date(Date.now() - MINUTE),
      },
    });
    await ctx.prisma.message.create({
      data: {
        conversationId: conv.id,
        seq: 2,
        role: 'agent',
        content: 'Both duplicate charges are refunded.',
        meta: { turn_id: answered.id },
      },
    });

    const report = await reconciler.sweep();

    // Recorded as what it is - an abandoned turn - and separated in the report,
    // because "we closed a leaked lease" and "we produced a fail-safe outcome
    // for a waiting customer" are different events for an operator.
    expect(report.turns.failedSafe).toEqual([]);
    expect(report.turns.superseded).toEqual([abandoned.id]);

    const after = await ctx.prisma.agentTurn.findUniqueOrThrow({ where: { id: abandoned.id } });
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/abandoned/);
    // No decision invented for it: nothing acted on this turn, so a fail-safe
    // decision here would put a `degraded` escalation in the audit trail of a
    // conversation that was answered normally.
    expect(after.decision).toBeNull();

    // The conversation is untouched: no second reply contradicting the first,
    // and the status the answering turn chose still stands.
    const messages = await ctx.prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { seq: 'asc' },
    });
    expect(messages.map((m) => m.role)).toEqual(['customer', 'agent']);
    expect(messages[1]?.content).toBe('Both duplicate charges are refunded.');
    expect(
      (await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).status,
    ).toBe('open');
  });

  it('H3b: a turn that commits while the sweep is blocked keeps its real decision', async () => {
    // The genuine race, reproduced rather than reasoned about: the sweep's scan
    // sees `running` (the request's transaction is still uncommitted, so READ
    // COMMITTED shows the old row), and by the time the sweep gets the
    // conversation lock the request has committed its real decision.
    //
    // Two things have to be true for the reconciler to lose that race, which is
    // the outcome we want: it must take `FOR UPDATE` on the conversation row
    // FIRST - the same lock a turn's closing transaction takes first - and its
    // claim must be a conditional UPDATE on `status = 'running'` taken INSIDE
    // that lock. Drop either and a live turn's decision is overwritten by a
    // fail-safe one, which is a worse bug than the leak.
    const conv = await conversation();
    const turn = await abandonedTurn(conv.id, 30 * MINUTE);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlightRequest = ctx.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conv.id} FOR UPDATE`;
        await tx.agentTurn.update({
          where: { id: turn.id },
          data: { status: 'ok', decision: { urgency: 'low' }, error: null },
        });
        await held;
      },
      { timeout: 20_000 },
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    const sweeping = reconciler.sweep();
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await inFlightRequest;

    const report = await sweeping;
    expect(report.turns.failedSafe).toEqual([]);

    const after = await ctx.prisma.agentTurn.findUniqueOrThrow({ where: { id: turn.id } });
    expect(after.status).toBe('ok');
    expect(after.error).toBeNull();
    // No fail-safe reply appended on top of the real one.
    expect(await ctx.prisma.message.count()).toBe(0);
    expect(
      (await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).status,
    ).toBe('open');
  }, 30_000);

  it('H3c: a turn already in a terminal status is not re-reconciled', async () => {
    // The scan predicate itself: `failed` is the status a reconciled turn ends
    // in, so a scan that forgot to filter on `running` would re-reply to every
    // ticket it had already handled, once a minute, forever.
    const conv = await conversation();
    const turn = await ctx.prisma.agentTurn.create({
      data: {
        conversationId: conv.id,
        traceId: 'trace-done',
        model: 'gpt-4.1-mini',
        promptVersion: 'v5',
        status: 'failed',
        error: 'abandoned: an earlier sweep already handled this',
        createdAt: new Date(Date.now() - 30 * MINUTE),
      },
    });

    const report = await reconciler.sweep();

    expect(report.turns.failedSafe).toEqual([]);
    expect((await ctx.prisma.agentTurn.findUniqueOrThrow({ where: { id: turn.id } })).error).toBe(
      'abandoned: an earlier sweep already handled this',
    );
    expect(await ctx.prisma.message.count()).toBe(0);
  });

  it('H3d: reconciling a turn does not deadlock against live turns on the same ticket', async () => {
    // The reconciler's transaction writes `messages`, `agent_turns` and
    // `conversations` - all of which take FOR KEY SHARE on the same
    // `conversations` row through their FK, and the last of which needs to
    // UPGRADE that to FOR UPDATE. Taking the weak locks first and upgrading is
    // exactly the inversion that deadlocked two concurrent turns (lifecycle
    // G2), so this transaction has to take `FOR UPDATE` up front, in the same
    // order `ConversationService.runTurnFor` does. It also reads max(seq) after
    // that lock, or two writers pick the same UNIQUE (conversation_id, seq).
    ctx.llm.script([
      { kind: 'decision', decision: decisionFixture({ operator_summary: 'One.' }) },
      { kind: 'decision', decision: decisionFixture({ operator_summary: 'Two.' }) },
      { kind: 'decision', decision: decisionFixture({ operator_summary: 'Three.' }) },
    ]);

    const conv = await conversation();
    await ctx.prisma.message.create({
      data: { conversationId: conv.id, seq: 1, role: 'customer', content: 'Charged twice.' },
    });
    const abandoned = await abandonedTurn(conv.id, 30 * MINUTE);

    // Three live turns and the sweep all commit against the same conversation
    // row at once.
    ctx.llm.barrier(3);
    const inFlight = Promise.all(
      [1, 2, 3].map((n) =>
        post(`/conversations/${conv.id}/messages`, {
          role: 'operator',
          content: `Concurrent operator question ${n}`,
        }),
      ),
    );
    // The sweep must not win by simply being faster than three HTTP requests:
    // wait until all three have opened their turn rows (they are then held at
    // the model call by the barrier), so what this test measures is the
    // overlap of four closing transactions and not who started first.
    await untilTurnsOpen(conv.id, 4);
    const [responses, report] = await Promise.all([inFlight, reconciler.sweep()]);

    for (const res of responses) expect(res.statusCode).toBe(200);
    // Superseded, not fail-safed, and deterministically so: each of the three
    // operator questions opens its own `agent_turns` row before its model call,
    // so by the time the sweeper takes the conversation lock there are three
    // turns newer than the abandoned one. Appending its fail-safe reply here is
    // precisely the behaviour the bound removed - three fresh answers to the
    // operator followed by "we could not process this, a human will follow up",
    // and `awaiting_human` written over whatever the live turns decided.
    expect(report.turns.failedSafe).toEqual([]);
    expect(report.turns.superseded).toEqual([abandoned.id]);
    // The lease is still released, which is what stops it being swept forever.
    expect(
      (await ctx.prisma.agentTurn.findUniqueOrThrow({ where: { id: abandoned.id } })).status,
    ).toBe('failed');

    // Contiguous, unique seqs prove the appends serialised rather than raced.
    const messages = await ctx.prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { seq: 'asc' },
    });
    const seqs = messages.map((m) => m.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    // 1 customer + 3 operator messages + 3 live agent replies, and nothing from
    // the sweep. Four transactions took the same locks in the same order and
    // all four committed: the deadlock this test exists for would have aborted
    // one of them.
    expect(messages).toHaveLength(7);
    expect(
      messages.filter((m) => m.meta && (m.meta as { reconciled?: boolean }).reconciled),
    ).toHaveLength(0);
  }, 30_000);

  it('H2c: a re-drive that throws leaves the row `executing` for the next sweep', async () => {
    // THROWN is infrastructure - a timeout, a 503, a gateway we could not
    // reach - which is not an answer, so we must not record one. Closing the
    // row as `failed` would clear the gauge without resolving anything, and on
    // the money path it would record "did not happen" about something that may
    // have. The lease was renewed, so the next sweep retries; the retry is free
    // because the result id is a pure function of the dedup key.
    const conv = await conversation();
    const row = await strandedSideEffect({
      conversationId: conv.id,
      ageMs: 30 * MINUTE,
      // `ch_fail*` is the fixture's DownstreamUnavailableError trigger.
      args: { ...refundArgs, charge_id: 'ch_fail_gateway' },
    });

    const report = await reconciler.sweep();

    expect(report.sideEffects.unresolved).toEqual([row.id]);
    expect(report.sideEffects.redriven).toEqual([]);
    expect(report.sideEffects.quarantined).toEqual([]);

    const after = await ctx.prisma.sideEffect.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('executing');
    expect(after.result).toBeNull();
    // The lease moved forward, so the row is not re-attempted until it is stale
    // again - which is what stops a broken gateway becoming a tight retry loop.
    expect(after.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime());
  });

  // -------------------------------------------------------------------------
  // H4/H5: idempotency_keys
  // -------------------------------------------------------------------------

  it('H4: a wedged `in_progress` key stops answering 409 and replays a recorded failure', async () => {
    ctx.llm.script([{ kind: 'decision', decision: decisionFixture() }]);
    const key = 'idem-wedged-1';
    // ONE body object, reused for all three requests: `ticket1()` derives its
    // message timestamps from `Date.now()` on every call, so calling it again
    // changes `request_hash` and the interceptor correctly answers 422
    // `idempotency_key_reused` instead of the 409 this test is about.
    const body = ticket1();

    // A real first attempt, so `route` and `request_hash` are the genuine
    // values the interceptor will compare a retry against, then pushed back to
    // `in_progress` to stand in for a process killed between the pre-handler
    // insert and the post-handler update.
    const first = await post('/tickets', body, { 'idempotency-key': key });
    expect(first.statusCode).toBe(201);
    await ctx.prisma.idempotencyKey.update({
      where: { key },
      data: {
        status: 'in_progress',
        statusCode: null,
        response: undefined,
        updatedAt: new Date(Date.now() - 30 * MINUTE),
      },
    });

    // Before the sweep: permanently 409, which is the bug.
    const wedged = await post('/tickets', body, { 'idempotency-key': key });
    expect(wedged.statusCode).toBe(409);
    expect(json(wedged).error.code).toBe('request_in_progress');

    const report = await reconciler.sweep();
    expect(report.idempotencyKeys.abandoned).toEqual([key]);

    const row = await ctx.prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(row.status).toBe('failed');
    expect(row.statusCode).toBe(503);

    // Replayed as a failure rather than re-run. The crashed attempt may already
    // have committed a conversation, a turn and side-effect rows, and re-running
    // would duplicate them under a second conversation id - a fresh dedup scope
    // for every conversation-scoped effect, so one charge can become two
    // pending refunds. The same trade-off `recordFailure` takes deliberately:
    // the client mints a new key.
    const retry = await post('/tickets', body, { 'idempotency-key': key });
    expect(retry.statusCode).toBe(503);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(json(retry).error.code).toBe('request_abandoned');
    expect(await ctx.prisma.conversation.count()).toBe(1);
  });

  it('H4b: a key the sweeper has answered stays answered, even by its own request', async () => {
    // The overlap the other direction from H1d. The sweeper decides a key is
    // abandoned and stores its 503 - the client's instruction is now "mint a
    // new key" - and then the request it gave up on comes back alive and writes
    // `completed` over it.
    //
    // The late write is the more TRUTHFUL of the two answers, and it is still
    // the wrong one to store: by then the client may already have retried under
    // a new key, and a key whose stored answer flips after it has been read
    // hands two different outcomes to the same `Idempotency-Key`. Terminal is
    // terminal here as everywhere else in this file - the honest answer still
    // reaches the caller that earned it, on this response, and the log keeps a
    // copy.
    ctx.llm.script([{ kind: 'decision', decision: decisionFixture() }]);
    const key = 'idem-late-writer';
    const body = ticket1();

    const release = ctx.llm.blockNext();
    const inFlight = post('/tickets', body, { 'idempotency-key': key });
    await ctx.llm.waitUntilBlocked();

    // The model call hangs long enough for the key's lease to look stale.
    await ctx.prisma.idempotencyKey.update({
      where: { key },
      data: { updatedAt: new Date(Date.now() - 30 * MINUTE) },
    });
    const report = await reconciler.sweep();
    expect(report.idempotencyKeys.abandoned).toEqual([key]);

    release();
    const res = await inFlight;
    // The caller that waited gets the real answer: the work did happen.
    expect(res.statusCode).toBe(201);
    expect(json(res).conversation_id).toBeDefined();

    const row = await ctx.prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(row.status).toBe('failed');
    expect(row.statusCode).toBe(503);

    // And the key keeps telling every later caller what it told the first one.
    const retry = await post('/tickets', body, { 'idempotency-key': key });
    expect(retry.statusCode).toBe(503);
    expect(json(retry).error.code).toBe('request_abandoned');
  });

  it('H5: retention deletes terminal keys past the TTL and never touches a live one', async () => {
    const day = 24 * 3600_000;
    const mk = (key: string, status: string, ageMs: number) =>
      ctx.prisma.idempotencyKey.create({
        data: {
          key,
          route: 'POST /tickets',
          requestHash: 'h',
          status,
          statusCode: 201,
          createdAt: new Date(Date.now() - ageMs),
          updatedAt: new Date(Date.now() - ageMs),
        },
      });

    await mk('old-completed', 'completed', 2 * day);
    await mk('old-failed', 'failed', 2 * day);
    await mk('fresh-completed', 'completed', MINUTE);
    // Older than the retention window but NOT terminal: deleting it would
    // release the key and let a retry create a second conversation, whose fresh
    // dedup scope can file an already-approved refund again. The stale pass
    // above owns this row, not retention.
    await mk('old-in-progress', 'in_progress', 2 * day);

    const report = await reconciler.sweep();
    expect(report.idempotencyKeys.purged).toBe(2);

    const remaining = (await ctx.prisma.idempotencyKey.findMany({ orderBy: { key: 'asc' } })).map(
      (r) => [r.key, r.status],
    );
    expect(remaining).toEqual([
      ['fresh-completed', 'completed'],
      // Aged out to a replayable failure by the stale pass in this same sweep.
      ['old-in-progress', 'failed'],
    ]);
  });

  // -------------------------------------------------------------------------
  // H6: the threshold itself
  // -------------------------------------------------------------------------

  it('H6: nothing younger than the threshold for its own state is touched', async () => {
    // Two thresholds, because the two states are not the same length of thing.
    //
    // A TURN has no wall-clock deadline: LLM_TIMEOUT_MS is per ATTEMPT, the
    // OpenAI adapter allows one retry, and MAX_AGENT_ITERATIONS bounds the
    // loop - so a legitimate request can run for minutes, and a threshold
    // shorter than that hands a fail-safe decision to live work, which is worse
    // than the bug. A SIDE-EFFECT claim is one provider call, and measuring it
    // with the turn's number left a stranded claim holding a global dedup key -
    // and with it a region's paging - for twelve minutes.
    //
    // Both rows here are younger than their own bound; the ages differ because
    // the bounds do, which is the whole point.
    const conv = await conversation();
    const sideEffect = await strandedSideEffect({ conversationId: conv.id, ageMs: 5_000 });
    const turn = await abandonedTurn(conv.id, MINUTE);

    const report = await reconciler.sweep();

    // 30s per attempt x 2 attempts x 6 iterations x 2 safety = 720_000ms.
    expect(report.staleAfterMs).toBe(720_000);
    // 30s per attempt x the same safety factor. One call, not one turn.
    expect(report.sideEffectStaleAfterMs).toBe(60_000);
    expect(report.sideEffects.redriven).toEqual([]);
    expect(report.sideEffects.quarantined).toEqual([]);
    expect(report.turns.failedSafe).toEqual([]);
    expect(report.turns.superseded).toEqual([]);

    expect(
      (await ctx.prisma.sideEffect.findUniqueOrThrow({ where: { id: sideEffect.id } })).status,
    ).toBe('executing');
    expect((await ctx.prisma.agentTurn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe(
      'running',
    );
  });

  // -------------------------------------------------------------------------
  // H7: observability
  // -------------------------------------------------------------------------

  it('H7: every reconciled row emits one structured event in the house shape', async () => {
    const conv = await conversation();
    const sideEffect = await strandedSideEffect({ conversationId: conv.id, ageMs: 30 * MINUTE });
    const turn = await abandonedTurn(conv.id, 30 * MINUTE);

    const logger = ctx.app.get(Logger);
    const warn = jest.spyOn(logger, 'warn');
    let events: Record<string, unknown>[];
    try {
      await reconciler.sweep();
      // Copied BEFORE mockRestore(), which clears `mock.calls` along with the spy.
      events = warn.mock.calls.map(([payload]) => payload as Record<string, unknown>);
    } finally {
      warn.mockRestore();
    }
    const sideEffectEvent = events.find((e) => e.event === 'reconcile.side_effect_redriven');
    expect(sideEffectEvent).toMatchObject({
      side_effect_id: sideEffect.id,
      conversation_id: conv.id,
      tool: 'issue_refund',
      dedup_key: DEDUP_KEY,
      status: 'succeeded',
    });
    // The full provider result, because on the money path the log line is the
    // second copy of the refund_id.
    expect((sideEffectEvent!.provider_result as { refund_id: string }).refund_id).toBe(
      stableId('re', DEDUP_KEY),
    );

    expect(events.find((e) => e.event === 'reconcile.turn_abandoned')).toMatchObject({
      turn_id: turn.id,
      conversation_id: conv.id,
    });
  });

  // -------------------------------------------------------------------------
  // H8: the timer
  // -------------------------------------------------------------------------

  it('H8: the interval drives the pass and never lets two sweeps overlap', async () => {
    // The only test that touches the timer, and it stubs the pass: a sweep held
    // open across many ticks must produce exactly ONE call, or a slow sweep
    // stacks up and eats the connection pool.
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sweep = jest.spyOn(reconciler, 'sweep').mockImplementation(async () => {
      calls += 1;
      await gate;
      return null as never;
    });

    try {
      reconciler.startSweeping(5);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(calls).toBe(1);
    } finally {
      release();
      reconciler.stopSweeping();
      sweep.mockRestore();
    }
  });
});
