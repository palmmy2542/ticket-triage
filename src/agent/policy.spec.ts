import { evaluate, describePolicy } from './policy';
import { createToolRegistry } from './tools/registry';
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
      reason: 'duplicate charge',
    });
    expect(decision.kind).toBe('requires_approval');
    // Dedup key is derived by the server from the charge, never supplied by the model.
    expect(decision.kind === 'requires_approval' && decision.dedupKey).toBe('ch_3f22b');
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

  it('exposes the boundary for documentation and audit', () => {
    expect(describePolicy(registry)).toEqual(
      expect.arrayContaining([
        { tool: 'issue_refund', autonomy: 'requires_approval', side_effecting: true },
        { tool: 'open_incident', autonomy: 'auto', side_effecting: true },
        { tool: 'search_knowledge_base', autonomy: 'auto', side_effecting: false },
      ]),
    );
  });
});

describe('registry construction', () => {
  it('refuses a side-effecting tool with no dedup key', () => {
    // Guards the extensibility claim: a new side-effecting tool cannot be added
    // without declaring how retries are deduplicated.
    const bad = () => {
      const tools = createToolRegistry({ latencyMs: 0 });
      const refund = tools.get('issue_refund')!;
      const broken = { ...refund, dedupKey: undefined };
      if (broken.sideEffecting && !broken.dedupKey) {
        throw new Error(`Tool ${broken.name} is side-effecting but declares no dedupKey`);
      }
    };
    expect(bad).toThrow(/declares no dedupKey/);
  });
});
