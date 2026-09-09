/**
 * A. Ingest + audit trail
 * C. Autonomous side effect (ticket 2, open_incident)
 * F. Contract / error shapes
 *
 * See test/support/app.ts for the shared app bootstrap and ticket fixtures.
 */
import type { LightMyRequestResponse } from 'fastify';

import { PROMPT_VERSION } from '../src/agent/prompt';
import { decisionFixture } from '../src/agent/llm/fake';
import { createTestApp, truncateAll, ticket2, ticket3, type TestApp } from './support/app';

const incidentArgs = (region: string) => ({
  severity: 'sev2' as const,
  region,
  title: 'Regional API failures reported by enterprise account',
  summary:
    'Multiple users on a 45-seat enterprise account see HTTP 500s; regional probes are degraded.',
});

describe('Tickets: ingest, audit trail, autonomous side effects, contract shapes (e2e)', () => {
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

  // ---------------------------------------------------------------------------
  // A. Ingest + audit trail
  // ---------------------------------------------------------------------------

  describe('A. Ingest + audit trail', () => {
    it('A1: POST /tickets returns 201 with the full turn envelope', async () => {
      ctx.llm.script([
        {
          kind: 'tools',
          calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
        },
        { kind: 'decision', decision: decisionFixture() },
      ]);

      const res = await post('/tickets', ticket3());
      expect(res.statusCode).toBe(201);

      const body = json(res);
      expect(typeof body.conversation_id).toBe('string');
      expect(typeof body.turn_id).toBe('string');
      expect(typeof body.trace_id).toBe('string');
      expect(body.decision).toBeDefined();
      expect(typeof body.agent_reply).toBe('string');
      expect(body.degraded).toBe(false);
    });

    it('A2-A3: GET /conversations/:id returns the audit trail; the decision carries server-owned fields', async () => {
      ctx.llm.script([
        {
          kind: 'tools',
          calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
        },
        { kind: 'decision', decision: decisionFixture() },
      ]);

      const ingest = json(await post('/tickets', ticket3()));
      const res = await get(`/conversations/${ingest.conversation_id}`);
      expect(res.statusCode).toBe(200);
      const body = json(res);

      // A2: messages in seq order, four customer then one agent.
      expect(body.messages).toHaveLength(5);
      expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
        'customer',
        'customer',
        'customer',
        'customer',
        'agent',
      ]);
      expect(body.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3, 4, 5]);

      // A2: exactly one turn, ok, v1, fake-gpt, numeric latency.
      expect(body.turns).toHaveLength(1);
      const turn = body.turns[0];
      expect(turn.status).toBe('ok');
      // Imported rather than hard-coded: the assertion is that the prompt version
      // is recorded on the turn, not which version happens to be current.
      expect(turn.prompt_version).toBe(PROMPT_VERSION);
      expect(turn.model).toBe('fake-gpt');
      expect(typeof turn.latency_ms).toBe('number');

      // A2: one tool_calls entry for search_knowledge_base.
      expect(body.tool_calls).toHaveLength(1);
      const call = body.tool_calls[0];
      expect(call.tool).toBe('search_knowledge_base');
      expect(call.args).toBeDefined();
      expect(call.result).toBeDefined();
      expect(call.policy_outcome).toBe('allowed');
      expect(call.status).toBe('succeeded');

      // A2: no side effects for a read-only turn.
      expect(body.side_effects).toEqual([]);

      // A3: the persisted decision has server-owned fields set correctly.
      expect(turn.decision.requires_human).toBe(false);
      expect(turn.decision.degraded).toBe(false);
      expect(turn.decision.tools_used).toEqual([
        expect.objectContaining({ name: 'search_knowledge_base', status: 'succeeded' }),
      ]);
      expect(turn.decision.pending_side_effect_ids).toEqual([]);
      expect(turn.decision.prompt_version).toBe(PROMPT_VERSION);
      expect(turn.decision.model).toBe('fake-gpt');
    });

    it('A4: POST /conversations/:id/messages (operator) appends and re-triages, seeing the previous decision', async () => {
      ctx.llm.script([
        {
          kind: 'tools',
          calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
        },
        { kind: 'decision', decision: decisionFixture() },
        { kind: 'decision', decision: decisionFixture({ operator_summary: 'Answered the operator.' }) },
      ]);

      const ingest = json(await post('/tickets', ticket3()));
      const res = await post(`/conversations/${ingest.conversation_id}/messages`, {
        role: 'operator',
        content: 'Can you confirm the workspace release before we reply?',
      });
      expect(res.statusCode).toBe(200);

      const conv = json(await get(`/conversations/${ingest.conversation_id}`));
      expect(conv.turns).toHaveLength(2);
      const roles = conv.messages.map((m: { role: string }) => m.role);
      expect(roles).toEqual(['customer', 'customer', 'customer', 'customer', 'agent', 'operator', 'agent']);

      // The second turn's request must have carried the previous decision.
      const lastRequest = ctx.llm.requests[ctx.llm.requests.length - 1]!;
      const userTurn = lastRequest.messages.find((m) => m.role === 'user');
      expect(userTurn?.content).toContain('<previous_triage>');
    });

    it('A5: a fourth customer message also re-triages and can escalate', async () => {
      ctx.llm.script([
        {
          kind: 'tools',
          calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
        },
        { kind: 'decision', decision: decisionFixture() },
        {
          kind: 'decision',
          decision: decisionFixture({
            urgency: 'critical',
            sentiment: 'angry',
            next_action: 'escalate_to_human',
            customer_reply_draft: null,
          }),
        },
      ]);

      const ingest = json(await post('/tickets', ticket3()));
      const res = await post(`/conversations/${ingest.conversation_id}/messages`, {
        role: 'customer',
        content: 'Still nothing?! I am extremely frustrated and considering cancelling.',
      });
      expect(res.statusCode).toBe(200);
      const body = json(res);
      expect(body.decision.requires_human).toBe(true);
      expect(body.decision.next_action).toBe('escalate_to_human');

      const conv = json(await get(`/conversations/${ingest.conversation_id}`));
      expect(conv.turns).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // C. Autonomous side effect (ticket 2)
  // ---------------------------------------------------------------------------

  describe('C. Autonomous side effect (ticket 2)', () => {
    it('C1-C3: open_incident pages once, autonomously, and the audit trail records the status disagreement', async () => {
      ctx.llm.script([
        { kind: 'tools', calls: [{ name: 'check_service_status', args: { region: null } }] },
        { kind: 'tools', calls: [{ name: 'open_incident', args: incidentArgs('asia-southeast-1') }] },
        {
          kind: 'decision',
          decision: decisionFixture({
            urgency: 'critical',
            product_area: 'platform',
            issue_type: 'outage',
            language: 'th',
            next_action: 'escalate_to_human',
            customer_reply_draft: null,
          }),
        },
        // Turn 2: model tries to open the SAME incident again.
        { kind: 'tools', calls: [{ name: 'open_incident', args: incidentArgs('asia-southeast-1') }] },
        {
          kind: 'decision',
          decision: decisionFixture({
            urgency: 'critical',
            product_area: 'platform',
            issue_type: 'outage',
            language: 'th',
            next_action: 'escalate_to_human',
            customer_reply_draft: null,
          }),
        },
      ]);

      const ingest = json(await post('/tickets', ticket2()));

      // C1: one side_effects row, autonomous (no approval needed).
      let conv = json(await get(`/conversations/${ingest.conversation_id}`));
      expect(conv.side_effects).toHaveLength(1);
      const incident = conv.side_effects[0];
      expect(incident.tool).toBe('open_incident');
      expect(incident.dedup_key).toBe('asia-southeast-1');
      expect(incident.status).toBe('succeeded');
      expect(incident.result.paged).toEqual(['oncall-platform-asia-southeast-1']);

      // C3: the check_service_status call recorded the public/probe disagreement.
      const statusCall = conv.tool_calls.find(
        (c: { tool: string }) => c.tool === 'check_service_status',
      );
      expect(statusCall.result.region_probe.state).toBe('degraded');
      expect(statusCall.result.public_status_page.summary).toBe('All systems operational');
      expect(statusCall.result.agrees_with_public_page).toBe(false);

      // C2: a second turn asking to open the same incident does not page twice.
      await post(`/conversations/${ingest.conversation_id}/messages`, {
        role: 'operator',
        content: 'Any update on the outage?',
        // Authorized on purpose: what C2 asserts is that DEDUP stops the second
        // page, and an unauthorized turn would be stopped one layer earlier by
        // the policy - a pass that says nothing about the unique index.
        authorize_actions: true,
      });

      conv = json(await get(`/conversations/${ingest.conversation_id}`));
      expect(conv.side_effects).toHaveLength(1);
      // `tool_calls` is ordered by (turn_id, seq); turn_id is a random UUID,
      // so it does not sort chronologically - find by content, not position.
      const incidentCalls = conv.tool_calls.filter(
        (c: { tool: string }) => c.tool === 'open_incident',
      );
      expect(incidentCalls).toHaveLength(2);
      const dedupedCall = incidentCalls.find(
        (c: { result: { deduplicated?: boolean } }) => c.result?.deduplicated === true,
      );
      expect(dedupedCall).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // F. Contract / error shapes
  // ---------------------------------------------------------------------------

  describe('F. Contract / error shapes', () => {
    it('F1: GET /conversations/:unknown-uuid returns 404 conversation_not_found with a request_id', async () => {
      const res = await get('/conversations/00000000-0000-0000-0000-000000000000');
      expect(res.statusCode).toBe(404);
      const body = json(res);
      expect(body.error.code).toBe('conversation_not_found');
      expect(typeof body.error.request_id).toBe('string');
    });

    it('F2: GET /conversations/not-a-uuid returns 400', async () => {
      const res = await get('/conversations/not-a-uuid');
      expect(res.statusCode).toBe(400);
    });

    it('F3: POST /tickets with an invalid plan and empty messages returns 400 validation_failed with details.fieldErrors', async () => {
      const res = await post('/tickets', {
        customer: {
          id: 'cust_x',
          plan: 'ultra-plan', // not a valid enum value
          tenure_months: 1,
          region: 'us-east-1',
          prior_tickets: 0,
        },
        messages: [],
      });
      expect(res.statusCode).toBe(400);
      const body = json(res);
      expect(body.error.code).toBe('validation_failed');
      expect(typeof body.error.details.fieldErrors).toBe('object');
    });

    it('F4: POST /tickets with an unknown extra top-level field returns 400 (strict schema)', async () => {
      const res = await post('/tickets', { ...ticket3(), unexpected_field: 'nope' });
      expect(res.statusCode).toBe(400);
    });

    it('F5: every error response matches { error: { code, message, request_id } } with nothing else leaking', async () => {
      const res = await get('/conversations/00000000-0000-0000-0000-000000000000');
      const body = json(res);
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'request_id']);
      expect(JSON.stringify(body)).not.toMatch(/stack|driverError/i);
    });
  });
});
