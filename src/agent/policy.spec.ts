import { evaluate } from './policy';
import { assertRetrySafe, createToolRegistry } from './tools/registry';
import type { ToolContext } from './types';

const registry = createToolRegistry({ latencyMs: 0 });

const ctx: ToolContext = {
  conversationId: 'conv_1',
  customer: {
    id: 'cust_1001',
    plan: 'free',
    tenure_months: 4,
    region: 'us-east-1',
    prior_tickets: 0,
  },
  now: new Date('2026-09-07T12:00:00.000Z'),
  log: { debug() {}, info() {}, warn() {}, error() {} },
};

const call = (name: string, args: unknown, budget = 4) =>
  evaluate({ registry, name, rawArgs: JSON.stringify(args), ctx, sideEffectBudget: budget });

const callUnauthorized = (name: string, args: unknown) =>
  evaluate({
    registry,
    name,
    rawArgs: JSON.stringify(args),
    ctx,
    sideEffectBudget: 4,
    sideEffectsAuthorized: false,
  });

describe('autonomy policy', () => {
  it('allows read-only tools without approval', () => {
    const decision = call('search_knowledge_base', { query: 'dark mode', limit: null });
    expect(decision.kind).toBe('allow');
  });

  it('requires human approval for refunds, always', () => {
    const decision = call('issue_refund', {
      charge_id: 'ch_3f22b',
      amount_cents: 2999,
      currency: 'USD',
      reason: 'Duplicate of ch_3f21a; same amount charged twice within the hour.',
    });
    expect(decision.kind).toBe('requires_approval');
    // Dedup key is derived by the server from the conversation's customer and
    // the charge, never supplied by the model. The customer is in the key
    // because the key is what names whose money moves.
    expect(decision.kind === 'requires_approval' && decision.dedupKey).toBe('cust_1001:ch_3f22b');
  });

  it('allows paging on-call autonomously, deduplicated per region', () => {
    const decision = call('open_incident', {
      severity: 'sev2',
      region: 'asia-southeast-1',
      title: 'Regional API errors',
      summary: 'Elevated 500s reported by an enterprise account in asia-southeast-1.',
    });
    expect(decision.kind).toBe('allow');
    expect(decision.kind === 'allow' && decision.dedupKey).toBe('asia-southeast-1');
  });

  it('denies a tool that does not exist', () => {
    const decision = call('wire_transfer', { amount: 1 });
    expect(decision).toMatchObject({ kind: 'deny', code: 'unknown_tool' });
  });

  it('denies arguments that are not valid JSON', () => {
    const decision = evaluate({
      registry,
      name: 'get_customer_account',
      rawArgs: '{not json',
      ctx,
      sideEffectBudget: 4,
    });
    expect(decision).toMatchObject({ kind: 'deny', code: 'malformed_arguments' });
  });

  it('denies arguments that fail the tool schema', () => {
    const decision = call('issue_refund', { charge_id: 'ch_1', amount_cents: -5, currency: 'US' });
    expect(decision).toMatchObject({ kind: 'deny', code: 'invalid_arguments' });
  });

  it('denies a refund whose `reason` is too thin to authorise', () => {
    // The floor exists because `reason` plus the decision context IS the
    // approval payload: an operator authorising real money on "dup" has been
    // handed a charge id, an amount, and nothing to judge. Raising the floor
    // without a test here left the only enforcement in a schema literal.
    const short = {
      charge_id: 'ch_3f22b',
      amount_cents: 2999,
      currency: 'USD',
      reason: 'dup',
    };
    expect(call('issue_refund', short)).toMatchObject({
      kind: 'deny',
      code: 'invalid_arguments',
    });
    // Same call, a sentence instead of a word: the boundary is the reason
    // field's length and nothing else about this call.
    expect(
      call('issue_refund', {
        ...short,
        reason: 'Duplicate of ch_3f21a; the same amount was charged twice within the hour.',
      }).kind,
    ).toBe('requires_approval');
  });

  describe('a turn that is not authorized to act', () => {
    // An operator asking a question in natural language is not an instruction
    // to move money. The turn still re-triages and still reads whatever it
    // needs; what it must not do is file a refund or page an engineer because
    // of how a question was phrased. Authorizing an action is a separate,
    // explicit act by the operator.
    it('refuses a refund it would otherwise have filed for approval', () => {
      const args = {
        charge_id: 'ch_3f22b',
        amount_cents: 2999,
        currency: 'USD',
        reason: 'Duplicate of ch_3f21a; the same amount was charged twice within the hour.',
      };
      // Same call, authorized, is the control: this is about authorization and
      // not about the arguments.
      expect(call('issue_refund', args).kind).toBe('requires_approval');
      expect(callUnauthorized('issue_refund', args)).toMatchObject({
        kind: 'deny',
        code: 'side_effects_not_authorized',
      });
    });

    it('refuses paging too, which is the autonomous one', () => {
      // `open_incident` is the tool the agent may run alone, so it is the one
      // that would otherwise reach a provider inside an unauthorized turn.
      const args = {
        severity: 'sev2',
        region: 'us-east-1',
        title: 'Regional API failures on an enterprise account',
        summary: 'Multiple users on a 45-seat account see HTTP 500s; probes report degradation.',
      };
      expect(call('open_incident', args).kind).toBe('allow');
      expect(callUnauthorized('open_incident', args)).toMatchObject({
        kind: 'deny',
        code: 'side_effects_not_authorized',
      });
    });

    it('still allows every read, so the turn can answer the question', () => {
      // The whole point of the split: refusing to ACT is not refusing to look.
      expect(callUnauthorized('search_knowledge_base', { query: 'refund policy', limit: null }).kind)
        .toBe('allow');
      expect(callUnauthorized('get_customer_account', { customer_id: 'cust_1001' }).kind).toBe('allow');
      expect(callUnauthorized('check_service_status', { region: null }).kind).toBe('allow');
    });
  });

  it('denies side effects once the per-turn budget is spent', () => {
    const decision = call(
      'open_incident',
      {
        severity: 'sev2',
        region: 'us-east-1',
        title: 'Something broke',
        summary: 'A summary long enough to pass the contract check for sev2 incidents.',
      },
      0,
    );
    expect(decision).toMatchObject({ kind: 'deny', code: 'side_effect_budget_exhausted' });
  });

  it('never spends budget on read-only tools', () => {
    const decision = call('search_knowledge_base', { query: 'dark mode', limit: null }, 0);
    expect(decision.kind).toBe('allow');
  });

  it('pins the autonomy boundary of every registered tool', () => {
    // The only assertion on the (name, autonomy, sideEffecting) triples, and the
    // reason it is exhaustive rather than a `arrayContaining` of three: this is
    // what fails when a new tool arrives declaring `auto` for something that
    // moves money, or when an existing one is quietly widened. Read straight off
    // the registry - the README's tool table is hand-maintained markdown and
    // nothing checks it against this.
    expect(
      [...registry.values()].map((tool) => ({
        tool: tool.name,
        autonomy: tool.autonomy,
        side_effecting: tool.sideEffecting,
      })),
    ).toEqual([
      { tool: 'search_knowledge_base', autonomy: 'auto', side_effecting: false },
      { tool: 'get_customer_account', autonomy: 'auto', side_effecting: false },
      { tool: 'check_service_status', autonomy: 'auto', side_effecting: false },
      { tool: 'issue_refund', autonomy: 'requires_approval', side_effecting: true },
      { tool: 'open_incident', autonomy: 'auto', side_effecting: true },
    ]);
  });
});

describe('registry construction', () => {
  it('refuses a side-effecting tool with no dedup key', () => {
    // Guards the extensibility claim: a new side-effecting tool cannot be added
    // without declaring how retries are deduplicated. Calls the production
    // guard (`assertRetrySafe`, which createToolRegistry runs over its tool
    // list) instead of re-implementing the same `if` here - the earlier version
    // of this test asserted on its own copy of the rule and stayed green when
    // the real guard was deleted.
    const refund = registry.get('issue_refund')!;
    expect(() => assertRetrySafe([{ ...refund, dedupKey: undefined }])).toThrow(
      /issue_refund is side-effecting but declares no dedupKey/,
    );
  });

  it('accepts the five real tools', () => {
    expect(() => assertRetrySafe([...registry.values()])).not.toThrow();
    expect(() => createToolRegistry({ latencyMs: 0 })).not.toThrow();
  });
});
