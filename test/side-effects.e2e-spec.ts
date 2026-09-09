/**
 * B. Autonomy boundary + approvals - the core of the assignment.
 *
 * issue_refund is `autonomy: 'requires_approval'` (src/agent/tools/issue-refund.ts):
 * the model may only ask for a refund, never execute one. These tests prove
 * that boundary end to end over real HTTP + Postgres: pending rows are created
 * with no money moved, approval executes exactly once even under a retried or
 * concurrent request, rejection is terminal, and a downstream failure is
 * recorded rather than swallowed.
 */
import { randomUUID } from 'node:crypto';

import type { LightMyRequestResponse } from 'fastify';

import { decisionFixture } from '../src/agent/llm/fake';
import { stableId } from '../src/agent/tools/support';
import type { ToolRegistry } from '../src/agent/types';
import { ConversationService } from '../src/triage/conversation.service';
import { ReconcilerService } from '../src/triage/reconciler.service';
import { describeSideEffectStoreContract } from '../src/agent/testing/in-memory-side-effect-store';
import { SideEffectsService } from '../src/triage/side-effects.service';
import { createTestApp, truncateAll, ticket1, ticket2, type TestApp } from './support/app';

const refundArgs = (chargeId: string, amountCents = 2999) => ({
  charge_id: chargeId,
  amount_cents: amountCents,
  currency: 'USD',
  reason: 'duplicate charge for a failed upgrade',
});

describe('Side effects: approvals, rejection, dedup, failure recording (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
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
  const get = (url: string) => http().inject({ method: 'GET', url });
  const json = (res: LightMyRequestResponse) => JSON.parse(res.payload);

  it('B1: two refund requests become pending approvals; the guard overrides auto_respond', async () => {
    ctx.llm.script([
      { kind: 'tools', calls: [{ name: 'get_customer_account', args: { customer_id: 'cust_1001' } }] },
      {
        kind: 'tools',
        calls: [
          { name: 'issue_refund', args: refundArgs('ch_3f22b') },
          { name: 'issue_refund', args: refundArgs('ch_3f23c') },
        ],
      },
      {
        kind: 'decision',
        decision: decisionFixture({
          urgency: 'high',
          next_action: 'auto_respond',
          customer_reply_draft: 'We found the duplicate charges and are refunding them now.',
        }),
      },
    ]);

    const res = await post('/tickets', ticket1());
    expect(res.statusCode).toBe(201);
    const body = json(res);

    expect(body.decision.next_action).toBe('escalate_to_human');
    expect(body.decision.requires_human).toBe(true);
    expect(body.decision.pending_side_effect_ids).toHaveLength(2);
    expect(body.decision.guard_notes.some((n: string) => n.includes('pending_human_approval'))).toBe(
      true,
    );

    const conv = json(await get(`/conversations/${body.conversation_id}`));
    expect(conv.side_effects).toHaveLength(2);
    const dedupKeys = conv.side_effects.map((s: { dedup_key: string }) => s.dedup_key).sort();
    // Customer-scoped since the refund dedup key became `<customer>:<charge>`:
    // a bare charge id said nothing about whose money it was, so a stored
    // result could be replayed for a conversation about someone else.
    expect(dedupKeys).toEqual(['cust_1001:ch_3f22b', 'cust_1001:ch_3f23c']);
    for (const sideEffect of conv.side_effects) {
      expect(sideEffect.tool).toBe('issue_refund');
      expect(sideEffect.status).toBe('pending_approval');
      expect(sideEffect.result).toBeNull();
    }
  });

  it('B2-B3: approving executes exactly once; a retried approval replays the same result', async () => {
    ctx.llm.script([
      { kind: 'tools', calls: [{ name: 'get_customer_account', args: { customer_id: 'cust_1001' } }] },
      { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f22b') }] },
      { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
    ]);

    const ingest = json(await post('/tickets', ticket1()));
    const sideEffectId = ingest.decision.pending_side_effect_ids[0];

    const firstRes = await post(
      `/conversations/${ingest.conversation_id}/side-effects/${sideEffectId}/approve`,
    );
    // Bug (see final report): the controller has no @HttpCode(200), so Nest's
    // default for @Post() (201) is returned instead of the 200 the write-up
    // specifies. Asserted literally here rather than weakened.
    expect(firstRes.statusCode).toBe(200);
    const first = json(firstRes);
    expect(first.replayed).toBe(false);
    expect(first.side_effect.status).toBe('succeeded');
    expect(typeof first.side_effect.result.refund_id).toBe('string');
    expect(first.side_effect.result.status).toBe('pending_settlement');

    const secondRes = await post(
      `/conversations/${ingest.conversation_id}/side-effects/${sideEffectId}/approve`,
    );
    expect(secondRes.statusCode).toBe(200); // same bug as above
    const second = json(secondRes);
    expect(second.replayed).toBe(true);
    expect(second.side_effect.result.refund_id).toBe(first.side_effect.result.refund_id);
  });

  it('B4: two concurrent approvals of the same pending side effect execute exactly once', async () => {
    ctx.llm.script([
      { kind: 'tools', calls: [{ name: 'get_customer_account', args: { customer_id: 'cust_1001' } }] },
      { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f23c') }] },
      { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
    ]);

    const ingest = json(await post('/tickets', ticket1()));
    const sideEffectId = ingest.decision.pending_side_effect_ids[0];
    const url = `/conversations/${ingest.conversation_id}/side-effects/${sideEffectId}/approve`;

    const [r1, r2] = await Promise.all([post(url), post(url)]);
    const results = [r1, r2].map((r) => ({ status: r.statusCode, body: JSON.parse(r.payload) }));

    // Note: the approve/reject handlers have no @HttpCode(200) - Nest's
    // default for @Post() is 201 - so we distinguish "executed or replayed"
    // from "409 conflict" rather than asserting the literal 200 the write-up
    // describes. See the final report for that separately-flagged bug.
    const conflicts = results.filter((r) => r.status === 409);
    const nonConflicts = results.filter((r) => r.status !== 409);
    expect(nonConflicts).toHaveLength(results.length - conflicts.length);

    const notReplayed = nonConflicts.filter((r) => r.body.replayed === false);
    const replayed = nonConflicts.filter((r) => r.body.replayed === true);

    // Exactly one caller performs the execution; the other either replays the
    // stored result or loses the race outright with 409 side_effect_in_progress.
    expect(notReplayed).toHaveLength(1);
    expect(replayed.length + conflicts.length).toBe(1);
    for (const r of conflicts) {
      expect(r.body.error.code).toBe('side_effect_in_progress');
    }

    const conv = json(await get(`/conversations/${ingest.conversation_id}`));
    const row = conv.side_effects.find((s: { id: string }) => s.id === sideEffectId);
    expect(row.status).toBe('succeeded');
    expect(typeof row.result.refund_id).toBe('string');
  });

  it('B5: reject is terminal and idempotent; approving a rejected side effect is a conflict', async () => {
    ctx.llm.script([
      { kind: 'tools', calls: [{ name: 'get_customer_account', args: { customer_id: 'cust_1001' } }] },
      { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f21a') }] },
      { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
    ]);

    const ingest = json(await post('/tickets', ticket1()));
    const sideEffectId = ingest.decision.pending_side_effect_ids[0];
    const base = `/conversations/${ingest.conversation_id}/side-effects/${sideEffectId}`;

    const rejected = json(await post(`${base}/reject`));
    expect(rejected.side_effect.status).toBe('rejected');

    // Bug (see final report): no @HttpCode(200) on the controller method, so
    // Nest's @Post() default (201) is returned instead of 200.
    const rejectedAgain = await post(`${base}/reject`);
    expect(rejectedAgain.statusCode).toBe(200);
    expect(json(rejectedAgain).side_effect.status).toBe('rejected');

    // Bug (see final report): side-effects.service.ts's `explainFailedClaim`
    // (called from `approve` when the row is no longer `pending_approval`)
    // returns normally with `{ side_effect, replayed: false }` for a
    // `rejected` row instead of throwing a ConflictException - only
    // `executing` throws. Approving an already-rejected side effect silently
    // succeeds instead of being refused, even though it does not change the
    // row (verified below). Asserted per the write-up rather than weakened.
    const approveAfterReject = await post(`${base}/approve`);
    expect(approveAfterReject.statusCode).toBe(409);

    const conv = json(await get(`/conversations/${ingest.conversation_id}`));
    const row = conv.side_effects.find((s: { id: string }) => s.id === sideEffectId);
    expect(row.status).toBe('rejected');
    expect(row.result).toBeNull();
  });

  it('B6: asking for the same refund again after execution does not create a second row', async () => {
    ctx.llm.script([
      { kind: 'tools', calls: [{ name: 'get_customer_account', args: { customer_id: 'cust_1001' } }] },
      {
        kind: 'tools',
        calls: [
          { name: 'issue_refund', args: refundArgs('ch_3f22b') },
          { name: 'issue_refund', args: refundArgs('ch_3f23c') },
        ],
      },
      { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
      // Turn 2: the model asks for the already-executed refund again.
      { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f22b') }] },
      { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
    ]);

    const ingest = json(await post('/tickets', ticket1()));
    const [executedId] = ingest.decision.pending_side_effect_ids as string[]; // ch_3f22b was requested first

    const approved = json(
      await post(`/conversations/${ingest.conversation_id}/side-effects/${executedId}/approve`),
    );
    expect(approved.side_effect.status).toBe('succeeded');

    await post(`/conversations/${ingest.conversation_id}/messages`, {
      role: 'operator',
      // Authorized, because dedup is what this test is about: an unauthorized
      // turn is refused by the policy before the store is ever consulted, which
      // would prove nothing about the unique index.
      authorize_actions: true,
      content: 'Please also refund the second duplicate charge again, just to be safe.',
    });

    const conv = json(await get(`/conversations/${ingest.conversation_id}`));
    expect(conv.side_effects).toHaveLength(2); // still 2, not 3

    // `tool_calls` is ordered by (turn_id, seq); turn_id is a random UUID, so
    // it does not sort chronologically. `turns` IS ordered by created_at, so
    // use turn 2's real id to find the repeated call rather than array position.
    expect(conv.turns).toHaveLength(2);
    const secondTurnId = conv.turns[1].id;
    const repeatedCall = conv.tool_calls.find(
      (c: { tool: string; turn_id: string }) => c.tool === 'issue_refund' && c.turn_id === secondTurnId,
    );
    expect(repeatedCall).toBeDefined();
    expect(repeatedCall.result.note).toMatch(/already executed/i);
  });

  it('B7: an unknown side-effect id and one from a different conversation both 404', async () => {
    ctx.llm.script([
      { kind: 'tools', calls: [{ name: 'get_customer_account', args: { customer_id: 'cust_1001' } }] },
      { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f22b') }] },
      { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
    ]);
    const convA = json(await post('/tickets', ticket1()));
    const realSideEffectId = convA.decision.pending_side_effect_ids[0];

    // A second, unrelated conversation.
    ctx.llm.script([
      { kind: 'tools', calls: [{ name: 'get_customer_account', args: { customer_id: 'cust_1001' } }] },
      { kind: 'decision', decision: decisionFixture() },
    ]);
    const convB = json(await post('/tickets', ticket1()));

    const unknownId = '11111111-1111-1111-1111-111111111111';
    const unknown = await post(`/conversations/${convA.conversation_id}/side-effects/${unknownId}/approve`);
    expect(unknown.statusCode).toBe(404);
    expect(json(unknown).error.code).toBe('side_effect_not_found');

    const crossConversation = await post(
      `/conversations/${convB.conversation_id}/side-effects/${realSideEffectId}/approve`,
    );
    expect(crossConversation.statusCode).toBe(404);
    expect(json(crossConversation).error.code).toBe('side_effect_not_found');
  });

  it('B8: a downstream payment failure is recorded as failed, not swallowed', async () => {
    ctx.llm.script([
      {
        kind: 'tools',
        calls: [{ name: 'issue_refund', args: refundArgs('ch_fail_001', 1000) }],
      },
      { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
    ]);

    const ingest = json(
      await post('/tickets', {
        customer: {
          id: 'cust_9999',
          plan: 'pro',
          tenure_months: 12,
          region: 'us-east-1',
          prior_tickets: 0,
        },
        messages: [{ at: new Date().toISOString(), text: 'Please refund my last charge.' }],
      }),
    );
    const sideEffectId = ingest.decision.pending_side_effect_ids[0];

    const approved = json(
      await post(`/conversations/${ingest.conversation_id}/side-effects/${sideEffectId}/approve`),
    );
    expect(approved.side_effect.status).toBe('failed');
    expect(approved.side_effect.result.error.code).toBe('downstream_unavailable');

    const conv = json(await get(`/conversations/${ingest.conversation_id}`));
    const row = conv.side_effects.find((s: { id: string }) => s.id === sideEffectId);
    expect(row.status).toBe('failed');
    expect(row.result.error.code).toBe('downstream_unavailable');
  });

  /**
   * The two ways `approve` could previously abandon a row it had already
   * claimed as `executing`. `executing` is a dead end - every later approve AND
   * reject is answered 409 `side_effect_in_progress`, with no sweeper and no age
   * check - so a throw past the claim made a pending refund permanently
   * un-actionable. Both are provoked by writing to the JSON column the code
   * reads back, which is exactly the untrusted surface both findings are about.
   */
  describe('a claimed row is never abandoned in `executing`', () => {
    const fileRefund = async () => {
      ctx.llm.script([
        { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f22b') }] },
        { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
      ]);
      const ingest = json(await post('/tickets', ticket1()));
      return {
        conversationId: ingest.conversation_id as string,
        sideEffectId: ingest.decision.pending_side_effect_ids[0] as string,
      };
    };

    it('B9 (F7): stored arguments that no longer satisfy the tool contract fail the row, no money moves', async () => {
      const { conversationId, sideEffectId } = await fileRefund();

      // Args were validated at filing time and never again, so this is what an
      // older deploy's row - or a hand-edited one - looks like on approval.
      // `amount_cents` is `z.number().int().min(1)`; a string cannot execute.
      await ctx.prisma.sideEffect.update({
        where: { id: sideEffectId },
        data: { args: { ...refundArgs('ch_3f22b'), amount_cents: '2999' } },
      });

      const approved = json(
        await post(`/conversations/${conversationId}/side-effects/${sideEffectId}/approve`),
      );
      expect(approved.side_effect.status).toBe('failed');
      expect(approved.side_effect.result.error.code).toBe('invalid_stored_arguments');
      expect(approved.side_effect.result.refund_id).toBeUndefined();

      // Terminal and visible, not stuck: a second approve replays the recorded
      // failure instead of answering 409 forever.
      const again = await post(
        `/conversations/${conversationId}/side-effects/${sideEffectId}/approve`,
      );
      expect(again.statusCode).toBe(200);
      expect(json(again).replayed).toBe(true);
      expect(json(again).side_effect.status).toBe('failed');
    });

    it('B10 (F4c): a context build that throws after the claim fails the row instead of stranding it', async () => {
      const { conversationId, sideEffectId } = await fileRefund();

      // `ctxFor` is ConversationService.toolContextFor: it re-reads the
      // conversation and runs CustomerProfileSchema.parse over a JSON column, so
      // a corrupt row throws. It used to throw from OUTSIDE the guarded block,
      // with the row already committed as `executing`.
      await ctx.prisma.conversation.update({
        where: { id: conversationId },
        data: { customer: { id: 'cust_1001', plan: 'platinum' } },
      });

      const res = await post(
        `/conversations/${conversationId}/side-effects/${sideEffectId}/approve`,
      );
      expect(res.statusCode).toBe(200);
      expect(json(res).side_effect.status).toBe('failed');
      expect(json(res).side_effect.result.error.code).toBe('context_unavailable');

      const row = await ctx.prisma.sideEffect.findUniqueOrThrow({ where: { id: sideEffectId } });
      expect(row.status).toBe('failed'); // the point: NOT 'executing'
      expect(row.result).not.toBeNull();
    });
  });

  /**
   * Dedup SCOPE, as opposed to the dedup key.
   *
   * The store's uniqueness was (conversation, tool, dedup_key) for every tool.
   * That is right for `issue_refund`, whose key names whose money moves, and
   * wrong for `open_incident`, whose key is a region - a region belongs to the
   * fleet, not to a ticket, so one real outage arriving on N tickets filed N
   * rows and made N provider calls.
   */
  describe('a later turn cannot speak over an open approval', () => {
    /**
     * Every message after the first re-runs the whole turn, which is what lets a
     * fourth angry customer message raise the urgency. It also means the NEWEST
     * decision speaks for the ticket - and `pending_side_effect_ids` is derived
     * from the records of the turn that produced it, so a refund filed by turn 1
     * was invisible to turn 2's guards.
     */
    const fileRefundThenAsk = async (question: string) => {
      ctx.llm.script([
        { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f22b') }] },
        { kind: 'decision', decision: decisionFixture({ urgency: 'high', next_action: 'escalate_to_human' }) },
      ]);
      const first = json(await post('/tickets', ticket1()));
      expect(first.decision.requires_human).toBe(true);

      // Turn 2 does its own lookup and wants to answer: grounded, non-groundable
      // issue type, a real draft - everything the guards ask for, except that a
      // human is still holding a refund on this ticket.
      ctx.llm.script([
        { kind: 'tools', calls: [{ name: 'check_service_status', args: { region: 'us-east-1' } }] },
        {
          kind: 'decision',
          decision: decisionFixture({
            urgency: 'high',
            issue_type: 'outage',
            product_area: 'api',
            next_action: 'auto_respond',
            customer_reply_draft: 'The region is healthy; your charges are being reviewed.',
          }),
        },
      ]);
      const second = json(
        await post(`/conversations/${first.conversation_id}/messages`, {
          role: 'operator',
          content: question,
        }),
      );
      return { conversationId: first.conversation_id as string, first, second };
    };

    it('B17: an operator question does not un-escalate a ticket with a refund pending', async () => {
      const { conversationId, second } = await fileRefundThenAsk('Any update? Looks handled to me.');

      expect(second.decision.next_action).toBe('escalate_to_human');
      expect(second.decision.requires_human).toBe(true);
      expect(second.decision.guard_notes.join(' ')).toContain('pending_human_approval');

      // The ticket stays in the human queue, and the refund is still theirs to
      // decide. `requires_human` is what writes the status, so one guard covers
      // both - there is no second rule about status to get out of step with.
      const conv = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(conv.status).toBe('awaiting_human');
      const rows = await ctx.prisma.sideEffect.findMany({ where: { conversationId } });
      expect(rows.map((r) => r.status)).toEqual(['pending_approval']);
    });

    it('B18: the same question after the refund is decided answers normally', async () => {
      const { conversationId } = await fileRefundThenAsk('Any update?');
      const pending = await ctx.prisma.sideEffect.findFirstOrThrow({ where: { conversationId } });
      await post(`/conversations/${conversationId}/side-effects/${pending.id}/reject`);

      // The control that keeps B17 about the OPEN approval rather than about
      // this ticket never auto-responding again: identical question, identical
      // evidence, nothing waiting on a human.
      ctx.llm.script([
        { kind: 'tools', calls: [{ name: 'check_service_status', args: { region: 'us-east-1' } }] },
        {
          kind: 'decision',
          decision: decisionFixture({
            urgency: 'high',
            issue_type: 'outage',
            product_area: 'api',
            next_action: 'auto_respond',
            customer_reply_draft: 'The region is healthy; the duplicate charge was reviewed.',
          }),
        },
      ]);
      const third = json(
        await post(`/conversations/${conversationId}/messages`, {
          role: 'operator',
          content: 'Any update?',
        }),
      );

      expect(third.decision.next_action).toBe('auto_respond');
      expect(third.decision.requires_human).toBe(false);
      expect(
        (await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).status,
      ).toBe('open');
    });
  });

  describe('an operator question is not an instruction to act', () => {
    /**
     * Every message re-runs the turn, so before this the phrasing of an
     * operator's question was enough to file a refund or page an engineer.
     * Reading stays open - the turn has to be able to answer - and acting
     * becomes something the operator authorizes explicitly.
     */
    const askAsOperator = async (conversationId: string, body: object) => {
      ctx.llm.script([
        { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f23c') }] },
        { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
      ]);
      return json(await post(`/conversations/${conversationId}/messages`, body));
    };

    const ticketWithNoPendingWork = async () => {
      ctx.llm.script([
        { kind: 'tools', calls: [{ name: 'get_customer_account', args: { customer_id: 'cust_1001' } }] },
        { kind: 'decision', decision: decisionFixture({ next_action: 'route_to_specialist', specialist_team: 'billing' }) },
      ]);
      return json(await post('/tickets', ticket1())).conversation_id as string;
    };

    it('B19: a question files nothing, and says which action it wanted', async () => {
      const conversationId = await ticketWithNoPendingWork();
      const answer = await askAsOperator(conversationId, {
        role: 'operator',
        content: 'What about the other duplicate charge?',
      });

      expect(await ctx.prisma.sideEffect.count({ where: { conversationId } })).toBe(0);
      expect(answer.decision.pending_side_effect_ids).toEqual([]);

      // Denied, not silently dropped: the attempt is in the audit trail with a
      // code an operator can read, which is how they know what to authorize.
      const conv = json(await get(`/conversations/${conversationId}`));
      const attempt = conv.tool_calls.find((c: { tool: string }) => c.tool === 'issue_refund');
      expect(attempt).toMatchObject({
        status: 'denied',
        policy_outcome: 'denied',
        result: { error: { code: 'side_effects_not_authorized' } },
      });
    });

    it('B20: the same question with the action authorized files it for approval', async () => {
      // The control, and the real workflow: two duplicate charges DO deserve two
      // refunds, so the operator has to be able to get there - by authorizing,
      // not by rewording. The refund still lands in `pending_approval`: this
      // authorizes filing, never executing.
      const conversationId = await ticketWithNoPendingWork();
      const answer = await askAsOperator(conversationId, {
        role: 'operator',
        content: 'Refund the other duplicate too.',
        authorize_actions: true,
      });

      expect(answer.decision.pending_side_effect_ids).toHaveLength(1);
      const rows = await ctx.prisma.sideEffect.findMany({ where: { conversationId } });
      expect(rows.map((r) => [r.toolName, r.status])).toEqual([['issue_refund', 'pending_approval']]);
    });

    it('B21: a customer message still triages with actions, unauthorized by nobody', async () => {
      // Ingest and inbound customer messages ARE the job the service was handed,
      // so they keep today's behaviour: the flag defaults to off and applies to
      // the operator channel only.
      const conversationId = await ticketWithNoPendingWork();
      const answer = await askAsOperator(conversationId, {
        role: 'customer',
        content: 'You charged me a third time today.',
      });

      expect(answer.decision.pending_side_effect_ids).toHaveLength(1);
      expect(await ctx.prisma.sideEffect.count({ where: { conversationId } })).toBe(1);
    });
  });

  describe('the thread says who each row was written for', () => {
    /**
     * `agentReply` is `decision.operator_summary` - the note to the operator -
     * and `customer_reply_draft` is never written to `messages` at all, so the
     * thread was already an internal record with nothing marking it as one. A
     * reader (or a UI, or the next engineer) had to infer from `role` whether a
     * row had been seen by the customer, and an operator's question and the
     * answer to it looked exactly like the customer conversation around them.
     *
     * `visibility` states it instead of leaving it to be inferred, and it is
     * derived on the server: a client cannot claim that a row the customer never
     * saw was customer-facing.
     */
    it('B22: customer rows are customer-visible; the operator exchange is internal', async () => {
      ctx.llm.script([
        { kind: 'tools', calls: [{ name: 'get_customer_account', args: { customer_id: 'cust_1001' } }] },
        { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
      ]);
      const ingest = json(await post('/tickets', ticket1()));

      ctx.llm.script([
        { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
      ]);
      await post(`/conversations/${ingest.conversation_id}/messages`, {
        role: 'operator',
        content: 'Any update?',
      });

      ctx.llm.script([
        { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
      ]);
      await post(`/conversations/${ingest.conversation_id}/messages`, {
        role: 'customer',
        content: 'I was charged again today.',
      });

      const conv = json(await get(`/conversations/${ingest.conversation_id}`));
      expect(conv.messages.map((m: { role: string; visibility: string }) => [m.role, m.visibility]))
        .toEqual([
          ['customer', 'customer'],
          ['customer', 'customer'],
          ['customer', 'customer'],
          ['customer', 'customer'],
          // The agent row is the operator summary, not a reply anyone sent.
          ['agent', 'internal'],
          ['operator', 'internal'],
          ['agent', 'internal'],
          ['customer', 'customer'],
          ['agent', 'internal'],
        ]);
    });

    it('B23: a client cannot post an internal row as customer-facing', async () => {
      // Derived from the channel, never accepted from the body: `strictObject`
      // rejects the unknown field outright rather than ignoring it, so a caller
      // that thinks it is setting visibility is told it is not.
      const res = await post(`/conversations/${randomUUID()}/messages`, {
        role: 'operator',
        content: 'Any update?',
        visibility: 'customer',
      });
      expect(res.statusCode).toBe(400);
      expect(json(res).error.code).toBe('validation_failed');
    });
  });

  describe('two writers, one claim', () => {
    /**
     * `executing` is a lease, and two processes can believe they hold one for
     * the same row: an approving request that stalls past the side-effect lease
     * and the sweeper that then re-drives it. Nothing locks between them - the
     * approve path holds no row lock across the provider call, deliberately, or
     * a hung payment gateway would hold a Postgres row for its whole timeout.
     *
     * So the rule cannot be "prevent the overlap", it has to be "the second
     * writer must not overwrite the first one's answer". These two tests are
     * the request-path half; the sweeper half is H1d in reconciler.e2e-spec.ts.
     */
    const pendingRefund = async () => {
      ctx.llm.script([
        { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f22b') }] },
        { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
      ]);
      const ingest = json(await post('/tickets', ticket1()));
      return {
        conversationId: ingest.conversation_id as string,
        sideEffectId: ingest.decision.pending_side_effect_ids[0] as string,
      };
    };

    /** A registry whose refund call fails, standing in for a provider timeout. */
    const registryWhoseRefundFails = (real: ToolRegistry): ToolRegistry => {
      const failing = new Map(real);
      const refund = failing.get('issue_refund')!;
      failing.set('issue_refund', {
        ...refund,
        execute: async () => {
          throw new Error('payments unavailable: gateway timeout');
        },
      });
      return failing;
    };

    it('B16: an approval that lost its lease keeps the refund the sweeper recorded', async () => {
      const { conversationId, sideEffectId } = await pendingRefund();
      const service = ctx.app.get(SideEffectsService);
      const conversations = ctx.app.get(ConversationService);
      const reconciler = ctx.app.get(ReconcilerService);

      // `ctxFor` runs after the claim and before the provider call, which is
      // exactly the window this is about: the approving process stalls there
      // (a slow conversation read, a paused container), its lease goes stale,
      // and a sweeper re-drives the row to a real, succeeded refund.
      const answer = await service.approve(
        conversationId,
        sideEffectId,
        registryWhoseRefundFails(conversations.toolRegistry),
        async () => {
          await ctx.prisma.sideEffect.update({
            where: { id: sideEffectId },
            data: { updatedAt: new Date(Date.now() - 5 * 60_000) },
          });
          const report = await reconciler.sweep();
          expect(report.sideEffects.redriven).toEqual([sideEffectId]);
          return conversations.toolContextFor(conversationId);
        },
      );

      // The money moved once and its id survived. `refund_id` is a pure
      // function of the server-derived dedup key, so this is the id BOTH
      // attempts would have produced - which is why losing the race is safe
      // and overwriting the winner would not have been.
      const row = await ctx.prisma.sideEffect.findUniqueOrThrow({ where: { id: sideEffectId } });
      expect(row.status).toBe('succeeded');
      expect((row.result as { refund_id: string }).refund_id).toBe(stableId('re', 'cust_1001:ch_3f22b'));

      // And the operator's own answer says so, rather than reporting the
      // failure of an attempt whose claim was already gone.
      expect(answer.side_effect.status).toBe('succeeded');
      expect(answer.side_effect.result).toEqual(row.result);
      expect(answer.replayed).toBe(true);
    });
  });

  describe('dedup scope: a region is global, a refund is not', () => {
    /**
     * Files an incident the way production does: the model checks the customer's
     * region, the probe comes back degraded, and the deterministic paging rule
     * in the runner pages on-call. No scripted open_incident call, so this
     * exercises the real path rather than a hand-fed one.
     */
    const ticketFromDegradedRegion = async () => {
      ctx.llm.script([
        {
          kind: 'tools',
          calls: [{ name: 'check_service_status', args: { region: 'asia-southeast-1' } }],
        },
        {
          kind: 'decision',
          decision: decisionFixture({ urgency: 'high', next_action: 'escalate_to_human' }),
        },
      ]);
      return json(await post('/tickets', ticket2()));
    };

    it('B11: one regional outage across two tickets files ONE incident row and pages once', async () => {
      const first = await ticketFromDegradedRegion();
      const second = await ticketFromDegradedRegion();
      expect(first.conversation_id).not.toBe(second.conversation_id);

      const rows = await ctx.prisma.sideEffect.findMany({ where: { toolName: 'open_incident' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dedupKey).toBe('asia-southeast-1');
      expect(rows[0]!.dedupScopeKey).toBe('global');
      // The ticket that noticed the outage keeps the row, so the audit trail
      // still answers "which ticket got us paged".
      expect(rows[0]!.conversationId).toBe(first.conversation_id);

      // The second ticket files nothing, but its trail is not blank: the tool
      // call records the same incident id, marked as a deduplication rather
      // than a page, which is how you get from ticket B back to the one row.
      const convA = json(await get(`/conversations/${first.conversation_id}`));
      const convB = json(await get(`/conversations/${second.conversation_id}`));
      expect(convA.side_effects).toHaveLength(1);
      expect(convB.side_effects).toHaveLength(0);

      const pagedB = convB.tool_calls.find((c: { tool: string }) => c.tool === 'open_incident');
      expect(pagedB.result.deduplicated).toBe(true);
      expect(pagedB.result.incident_id).toBe(convA.side_effects[0].result.incident_id);
    });

    it('B12: the same refund on two tickets stays two rows - the default scope must not follow', async () => {
      // The regression guard on the default. `issue_refund`'s key is
      // `<customer>:<charge>`, so making the store globally scoped for
      // everything would collapse these two into one row and let one ticket's
      // approval decision replay into an unrelated ticket about the same charge.
      const fileRefundOnItsOwnTicket = async () => {
        ctx.llm.script([
          { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f22b') }] },
          { kind: 'decision', decision: decisionFixture({ next_action: 'escalate_to_human' }) },
        ]);
        return json(await post('/tickets', ticket1()));
      };

      const first = await fileRefundOnItsOwnTicket();
      const second = await fileRefundOnItsOwnTicket();

      const rows = await ctx.prisma.sideEffect.findMany({ where: { toolName: 'issue_refund' } });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.dedupKey === 'cust_1001:ch_3f22b')).toBe(true);
      expect(new Set(rows.map((r) => r.conversationId))).toEqual(
        new Set([first.conversation_id, second.conversation_id]),
      );
      // Conversation-scoped rows scope on their own conversation id, which is
      // what keeps the two identical dedup keys from colliding.
      expect(new Set(rows.map((r) => r.dedupScopeKey))).toEqual(
        new Set([first.conversation_id, second.conversation_id]),
      );
      expect(first.decision.pending_side_effect_ids[0]).not.toBe(
        second.decision.pending_side_effect_ids[0],
      );
    });
  });

  /**
   * What a human is actually shown when asked to authorise money.
   *
   * The payload was id, tool, status, dedup_key, args, result, turn id and
   * timestamps - and for a refund `args` is a charge id, an amount, a currency
   * and `reason`. So the total information behind a one-click authorisation of
   * a real payment was a charge id, a number, and whatever the model wrote in
   * `reason`. Not who the customer is, not what we promised them, not what the
   * agent concluded. "The human catches the instance" needs the human to have
   * something to catch it with.
   */
  describe('the approval payload carries enough context to decide', () => {
    const fileRefundOnTicket1 = async () => {
      ctx.llm.script([
        { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f22b') }] },
        {
          kind: 'decision',
          decision: decisionFixture({
            next_action: 'escalate_to_human',
            rationale:
              'Three charges on a free plan in one month and the workspace never upgraded; ' +
              'ch_3f21a is the intended purchase, so only the two duplicates are refundable.',
          }),
        },
      ]);
      const ingest = json(await post('/tickets', ticket1()));
      return {
        conversationId: ingest.conversation_id as string,
        turnId: ingest.turn_id as string,
        sideEffectId: ingest.decision.pending_side_effect_ids[0] as string,
      };
    };

    it('B13: a pending refund names the customer, their plan and their tenure - not just a charge id', async () => {
      const { conversationId } = await fileRefundOnTicket1();

      const conv = json(await get(`/conversations/${conversationId}`));
      expect(conv.side_effects).toHaveLength(1);
      expect(conv.side_effects[0].decision_context).toMatchObject({
        customer_id: 'cust_1001',
        plan: 'free',
        tenure_months: 4,
        region: 'us-east-1',
      });
    });

      it('B14: the rationale of the turn that asked is stamped onto the rows the turn filed', async () => {
        const { conversationId, turnId } = await fileRefundOnTicket1();

        // Stamped by `runTurnFor` itself, so one ingest is enough. It CANNOT be
        // captured when the row is filed: the turn row is opened `running` with a
        // null decision before the model runs, and the rationale only exists once
        // the tool loop - which filed this row - has finished. So the turn stamps
        // it immediately after its own transaction commits.
        const conv = json(await get(`/conversations/${conversationId}`));
        const turn = conv.turns.find((t: { id: string }) => t.id === turnId);
        expect(turn.decision.rationale).toContain('ch_3f21a is the intended purchase');

        expect(conv.side_effects[0].decision_context).toMatchObject({
          // Merged, not replaced: the request-time customer snapshot survives the
          // stamp, so the operator sees whose money it is AND why the agent asked.
          customer_id: 'cust_1001',
          plan: 'free',
          rationale: turn.decision.rationale,
        });
      });

      it('B15b: a stamp that fails costs the audit field, never the turn', async () => {
        // The stamp is repair of an audit field on rows that are ALREADY
        // committed, and it runs after the turn's transaction on its own
        // connection. Letting it throw put a decision, an agent reply and a
        // filed refund in the database and then answered the caller 500 - which
        // also burns the Idempotency-Key, so the client's retry is refused and
        // the operator sees a failed request whose effects all landed.
        //
        // A missing `rationale` in the approval payload is a real cost: the
        // operator loses the WHY behind the refund they are being asked to
        // authorise. It is still the cheaper half by a wide margin, and the log
        // line names the row so it can be repaired.
        const stamp = jest
          .spyOn(ctx.app.get(SideEffectsService), 'stampTurnRationale')
          .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

        let filed: Awaited<ReturnType<typeof fileRefundOnTicket1>>;
        try {
          filed = await fileRefundOnTicket1();
        } finally {
          stamp.mockRestore();
        }

        const conv = json(await get(`/conversations/${filed.conversationId}`));
        expect(conv.turns).toHaveLength(1);
        expect(conv.turns[0].status).toBe('ok');
        expect(conv.side_effects).toHaveLength(1);
        expect(conv.side_effects[0].status).toBe('pending_approval');
        // The one thing actually lost: the rationale never reached the row.
        // Everything the turn committed is intact and the customer got a reply.
        expect(conv.side_effects[0].decision_context.rationale).toBeUndefined();
        expect(conv.side_effects[0].decision_context.customer_id).toBe('cust_1001');
        expect(conv.messages.filter((m: { role: string }) => m.role === 'agent')).toHaveLength(1);
      });

      it('B15: a turn stamps only the rows it filed, never another turn\'s', async () => {
        const first = await fileRefundOnTicket1();

        // A second turn on the same ticket, filing a different charge.
        ctx.llm.script([
          { kind: 'tools', calls: [{ name: 'issue_refund', args: refundArgs('ch_3f23c') }] },
          {
            kind: 'decision',
            decision: decisionFixture({
              next_action: 'escalate_to_human',
              rationale: 'Second turn: the operator asked about the other duplicate charge.',
            }),
          },
        ]);
        const second = json(
          await post(`/conversations/${first.conversationId}/messages`, {
            role: 'operator',
            content: 'What about the other duplicate?',
            // The operator authorizes the second refund; without it there is no
            // second row to stamp and nothing for this test to separate.
            authorize_actions: true,
          }),
        );

        // No manual stamp anywhere: each turn stamps its own rows as it commits.
        const conv = json(await get(`/conversations/${first.conversationId}`));
        const rows: Array<{ requested_by_turn_id: string; decision_context: { rationale?: string } }> =
          conv.side_effects;
        expect(rows).toHaveLength(2);

        const fromSecond = rows.find((r) => r.requested_by_turn_id === second.turn_id)!;
        const fromFirst = rows.find((r) => r.requested_by_turn_id === first.turnId)!;
        expect(fromSecond.decision_context.rationale).toBe(second.decision.rationale);
        // Turn one's row keeps turn ONE's reasoning. The stamp is scoped by
        // `requested_by_turn_id`, or the audit trail starts attributing one
        // decision's reasoning to another decision's request.
        expect(fromFirst.decision_context.rationale).toContain('ch_3f21a is the intended purchase');
        expect(fromFirst.decision_context.rationale).not.toBe(second.decision.rationale);
      });
  });

  /**
   * Postgres arm of the shared `SideEffectStore` contract. The in-memory arm
   * runs the SAME suite in the unit project
   * (src/agent/testing/side-effect-store.spec.ts).
   *
   * This is the half that was missing. Every unit test and the whole eval run
   * against the fake, this service only ever ran under e2e, and nothing
   * compared them - so the fake was evidence about the fake. Run below through
   * `forTurn`, i.e. the exact `SideEffectStore` the runner is handed.
   */
  describeSideEffectStoreContract({
    name: 'SideEffectsService over Postgres',
    make: async (conversationIds) => {
      // `side_effects.conversation_id` carries a foreign key, so the
      // conversations the suite will write against have to exist first. Real
      // customer JSON, because `requestApproval` reads it for the approval
      // payload's decision context.
      for (const id of conversationIds) {
        await ctx.prisma.conversation.create({
          data: {
            id,
            status: 'open',
            customer: {
              id: 'cust_1001',
              plan: 'free',
              tenure_months: 4,
              region: 'us-east-1',
              prior_tickets: 0,
            },
          },
        });
      }

      const turn = await ctx.prisma.agentTurn.create({
        data: {
          conversationId: conversationIds[0]!,
          traceId: randomUUID(),
          model: 'contract-test',
          promptVersion: 'contract-test',
          status: 'running',
        },
      });

      return ctx.app.get(SideEffectsService).forTurn(turn.id);
    },
  });
});
