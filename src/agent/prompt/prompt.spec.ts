import { existsSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Unit tests for prompt assembly: loading/caching the system prompt file and
 * building the per-turn message list from persisted conversation state.
 *
 * `now` is fixed throughout so relative-age rendering ("3h ago", "just now")
 * is deterministic.
 */
import { PROMPT_VERSION, systemPrompt, buildMessages } from './index';
import { decisionFixture } from '../llm/fake';
import type { ConversationMessage, CustomerProfile, LlmMessage } from '../types';
import type { Decision } from '../schema';

const NOW = new Date('2026-09-07T12:00:00.000Z');

const CUSTOMER: CustomerProfile = {
  id: 'cust_1001',
  plan: 'free',
  tenure_months: 4,
  region: 'us-east-1',
  prior_tickets: 0,
};

function fullDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    ...decisionFixture(),
    requires_human: false,
    degraded: false,
    injection_suspected: false,
    guard_notes: [],
    tools_used: [],
    pending_side_effect_ids: [],
    prompt_version: PROMPT_VERSION,
    model: 'fake-gpt',
    ...overrides,
  };
}

describe('systemPrompt', () => {
  it('loads the prompt file named by PROMPT_VERSION', () => {
    // Asserts the invariant (version tracks the filename) rather than a literal
    // version, so bumping the prompt does not require editing this test - but a
    // bump WITHOUT the matching file still fails loudly.
    expect(PROMPT_VERSION).toMatch(/^v\d+$/);
    expect(existsSync(join(__dirname, `system.${PROMPT_VERSION}.md`))).toBe(true);
    const prompt = systemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('You are the triage agent for a SaaS support team.');
  });

  it('strips HTML comments, including engineer WHY notes, before the prompt reaches the model', () => {
    const prompt = systemPrompt();
    expect(prompt).not.toContain('<!--');
    expect(prompt).not.toContain('-->');
    expect(prompt).not.toContain('WHY:');
  });

  it('still contains the load-bearing policy rules after stripping comments', () => {
    // Short, stable substrings: assert POLICY presence, not exact phrasing, so a
    // wording tweak to the surrounding prose does not break this suite.
    const prompt = systemPrompt();
    expect(prompt).toContain('Tone is not urgency.'); // tone-is-not-urgency rule
    expect(prompt).toContain('customer-supplied data'); // untrusted <ticket> rule
    expect(prompt).toContain('never move money'); // may-never-move-money rule
    // v2 additions: the boundary must state the obligation, not just the ban.
    expect(prompt).toContain('`issue_refund` once for each of them'); // file the request
    expect(prompt).toContain('not a substitute for paging'); // page, do not just escalate
    expect(prompt).toContain('Escalating is not free.'); // counter-pressure against over-escalation
  });

});

describe('buildMessages - structure', () => {
  it('puts a system message first, then exactly one user message with the customer_profile and ticket blocks', () => {
    const messages: ConversationMessage[] = [{ role: 'customer', content: 'Help please', at: NOW.toISOString() }];
    const built = buildMessages({ customer: CUSTOMER, messages, now: NOW });

    expect(built[0]).toEqual({ role: 'system', content: systemPrompt() });
    const userTurns = built.filter((m) => m.role === 'user');
    // Exactly one user message carries the ticket - later operator turns are
    // also 'user' role but are asserted separately by content/order below.
    const ticketTurn = built[1] as Extract<LlmMessage, { role: 'user' }>;
    expect(ticketTurn.role).toBe('user');
    expect(ticketTurn.content).toContain('<customer_profile>');
    expect(ticketTurn.content).toContain('<ticket>');
    expect(userTurns.length).toBeGreaterThanOrEqual(1);
  });

  it('renders customer messages inside <ticket> with relative ages, oldest first', () => {
    const messages: ConversationMessage[] = [
      { role: 'customer', content: 'It broke three hours ago', at: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() },
      { role: 'customer', content: 'Still broken', at: NOW.toISOString() },
    ];
    const built = buildMessages({ customer: CUSTOMER, messages, now: NOW });
    const ticketTurn = built[1] as Extract<LlmMessage, { role: 'user' }>;

    const ticketBlock = ticketTurn.content.slice(
      ticketTurn.content.indexOf('<ticket>'),
      ticketTurn.content.indexOf('</ticket>'),
    );
    expect(ticketBlock).toContain('[3h ago] It broke three hours ago');
    expect(ticketBlock).toContain('[just now] Still broken');
    // Oldest first: the 3h-ago line appears before the just-now line.
    expect(ticketBlock.indexOf('3h ago')).toBeLessThan(ticketBlock.indexOf('just now'));
  });

  it('does not duplicate customer messages as separate chat turns - they exist only inside <ticket>', () => {
    const messages: ConversationMessage[] = [
      { role: 'customer', content: 'UNIQUE_CUSTOMER_TEXT', at: NOW.toISOString() },
    ];
    const built = buildMessages({ customer: CUSTOMER, messages, now: NOW });
    // Only the ticket-carrying user turn (built[1]) should mention this text.
    const occurrences = built.filter((m) => 'content' in m && typeof m.content === 'string' && m.content.includes('UNIQUE_CUSTOMER_TEXT'));
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toBe(built[1]);
  });

  it('renders (no customer messages) rather than an empty ticket block for an empty conversation', () => {
    const built = buildMessages({ customer: CUSTOMER, messages: [], now: NOW });
    const ticketTurn = built[1] as Extract<LlmMessage, { role: 'user' }>;
    expect(ticketTurn.content).toContain('(no customer messages)');
  });

  it('turns a 4-message conversation into the exact expected role sequence, operator/agent after the ticket', () => {
    const messages: ConversationMessage[] = [
      { role: 'customer', content: 'My charge is wrong', at: new Date(NOW.getTime() - 3_600_000).toISOString() },
      { role: 'agent', content: 'Looking into it now.', at: new Date(NOW.getTime() - 1_800_000).toISOString() },
      { role: 'operator', content: 'Did you check the region?', at: new Date(NOW.getTime() - 900_000).toISOString() },
      { role: 'agent', content: 'Yes, region is healthy.', at: NOW.toISOString() },
    ];
    const built = buildMessages({ customer: CUSTOMER, messages, now: NOW });

    expect(built.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant']);
    expect(built[2]).toEqual({ role: 'assistant', content: 'Looking into it now.' });
    expect(built[3]).toEqual({ role: 'user', content: '[operator] Did you check the region?' });
    expect(built[4]).toEqual({ role: 'assistant', content: 'Yes, region is healthy.' });
  });
});

describe('buildMessages - customer profile block', () => {
  it('includes plan, region, tenure and seats when seats is present', () => {
    const withSeats: CustomerProfile = { ...CUSTOMER, seats: 12 };
    const built = buildMessages({ customer: withSeats, messages: [], now: NOW });
    const ticketTurn = built[1] as Extract<LlmMessage, { role: 'user' }>;
    expect(ticketTurn.content).toContain('plan: free');
    expect(ticketTurn.content).toContain('region: us-east-1');
    expect(ticketTurn.content).toContain('tenure_months: 4');
    expect(ticketTurn.content).toContain('seats: 12');
  });

  it('omits the seats line when seats is absent', () => {
    expect(CUSTOMER.seats).toBeUndefined();
    const built = buildMessages({ customer: CUSTOMER, messages: [], now: NOW });
    const ticketTurn = built[1] as Extract<LlmMessage, { role: 'user' }>;
    expect(ticketTurn.content).not.toContain('seats:');
  });
});

describe('buildMessages - previous triage', () => {
  it('includes a previous_triage block with urgency/next_action and the pending-approval list when non-empty', () => {
    const previousDecision = fullDecision({
      urgency: 'high',
      next_action: 'route_to_specialist',
      pending_side_effect_ids: ['se_refund_1', 'se_refund_2'],
    });
    const built = buildMessages({ customer: CUSTOMER, messages: [], previousDecision, now: NOW });
    const ticketTurn = built[1] as Extract<LlmMessage, { role: 'user' }>;

    expect(ticketTurn.content).toContain('<previous_triage>');
    expect(ticketTurn.content).toContain('urgency: high');
    expect(ticketTurn.content).toContain('next_action: route_to_specialist');
    expect(ticketTurn.content).toContain('awaiting_human_approval: se_refund_1, se_refund_2');
  });

  it('says "none" when pending_side_effect_ids is an empty array', () => {
    const previousDecision = fullDecision({ pending_side_effect_ids: [] });
    const built = buildMessages({ customer: CUSTOMER, messages: [], previousDecision, now: NOW });
    const ticketTurn = built[1] as Extract<LlmMessage, { role: 'user' }>;
    expect(ticketTurn.content).toContain('awaiting_human_approval: none');
  });
});
