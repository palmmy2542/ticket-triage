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
import type { LightMyRequestResponse } from 'fastify';

import { decisionFixture } from '../src/agent/llm/fake';
import { createTestApp, truncateAll, ticket1, type TestApp } from './support/app';

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
    expect(dedupKeys).toEqual(['ch_3f22b', 'ch_3f23c']);
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
});
