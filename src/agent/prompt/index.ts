/**
 * Prompt assembly.
 *
 * The prompt text lives in `system.<PROMPT_VERSION>.md` so it can be reviewed
 * as a document and diffed as code. `PROMPT_VERSION` is stored on every
 * persisted turn, so a decision made six weeks ago can be attributed to the
 * exact prompt that made it - without that, prompt changes are silent,
 * untraceable behaviour changes.
 *
 * Only the current version is in the working tree. A new version is a new file
 * and a bump here, so `git log src/agent/prompt/` is the version history
 * (v1-v5 so far) and eval/FINDINGS.md is what each bump measured.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConversationMessage, CustomerProfile, LlmMessage } from '../types';
import type { Decision } from '../schema';

export const PROMPT_VERSION = 'v5';

const PROMPT_FILE = `system.${PROMPT_VERSION}.md`;

/** Comments are for engineers, not the model: strip them before sending. */
function stripComments(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let cached: string | undefined;

export function systemPrompt(): string {
  // Read once, cache. The file is immutable at runtime.
  //
  // Deliberately untested: this is a performance detail with no observable
  // behaviour, and `fs.readFileSync` is non-configurable in current Node so a
  // spy cannot see it without mocking the whole module. There used to be a test
  // here asserting `systemPrompt()).toBe(systemPrompt())`, which passes on two
  // equal string PRIMITIVES whether or not anything is cached - it stayed green
  // with this line deleted. A test that cannot fail is worse than no test,
  // because it reads as coverage.
  cached ??= stripComments(readFileSync(join(__dirname, PROMPT_FILE), 'utf8'));
  return cached;
}

function relativeAge(at: string, now: Date): string {
  const ms = now.getTime() - new Date(at).getTime();
  if (Number.isNaN(ms)) return 'unknown';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface BuildMessagesInput {
  customer: CustomerProfile;
  /** Every persisted message for this conversation, oldest first. */
  messages: ConversationMessage[];
  /** Triage result of the previous turn, if any. Summarised, not replayed. */
  previousDecision?: Decision | null;
  now: Date;
  /** False for an operator question: the turn may read, but not act. */
  sideEffectsAuthorized?: boolean;
}

/**
 * Rebuild the full model input from persisted state on every turn.
 *
 * Deliberately stateless: we never rely on a provider-side conversation id, so
 * the service can restart, scale horizontally, or replay a turn for debugging.
 * The cost is re-sending the thread each turn; the benefit is that the database
 * is the single source of truth. Tool call transcripts from *previous* turns are
 * not replayed - only the resulting decision - which keeps token growth linear
 * in conversation length rather than quadratic.
 */
export function buildMessages(input: BuildMessagesInput): LlmMessage[] {
  const { customer, messages, previousDecision, now } = input;

  const customerMessages = messages.filter((m) => m.role === 'customer');
  const thread = customerMessages.map((m) => `[${relativeAge(m.at, now)}] ${m.content}`).join('\n');

  const profile = [
    `plan: ${customer.plan}`,
    `region: ${customer.region}`,
    `tenure_months: ${customer.tenure_months}`,
    customer.seats === undefined ? undefined : `seats: ${customer.seats}`,
    `prior_tickets: ${customer.prior_tickets}`,
    `customer_id: ${customer.id}`,
  ]
    .filter(Boolean)
    .join('\n');

  const parts = [
    '<customer_profile>',
    profile,
    '</customer_profile>',
    '',
    // The tag boundary is what the "untrusted input" prompt rule refers to.
    '<ticket>',
    thread || '(no customer messages)',
    '</ticket>',
  ];

  if (previousDecision) {
    parts.push(
      '',
      '<previous_triage>',
      `urgency: ${previousDecision.urgency}`,
      `next_action: ${previousDecision.next_action}`,
      `issue_type: ${previousDecision.issue_type}`,
      `rationale: ${previousDecision.rationale}`,
      previousDecision.pending_side_effect_ids.length > 0
        ? `awaiting_human_approval: ${previousDecision.pending_side_effect_ids.join(', ')}`
        : 'awaiting_human_approval: none',
      '</previous_triage>',
    );
  }

  parts.push(
    '',
    'Triage this ticket now. If an operator has asked you something below, answer it and re-triage.',
  );

  // Per-turn context, deliberately here and not in the system prompt: it
  // describes THIS request, so it must not move PROMPT_VERSION or invalidate an
  // eval baseline. The policy refuses the call either way - this only spares the
  // model a round trip discovering that.
  if (input.sideEffectsAuthorized === false) {
    parts.push(
      '',
      'This turn answers an operator question and is NOT authorized to take actions. Do not call ' +
        'issue_refund or open_incident: say which action you believe is needed and why, and the ' +
        'operator will authorize it explicitly.',
    );
  }

  const built: LlmMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: parts.join('\n') },
  ];

  // Operator/agent exchanges follow as real chat turns so multi-turn context is
  // natural to the model. Customer messages are already inside <ticket>.
  for (const message of messages) {
    if (message.role === 'operator') {
      built.push({ role: 'user', content: `[operator] ${message.content}` });
    } else if (message.role === 'agent') {
      built.push({ role: 'assistant', content: message.content });
    }
  }

  return built;
}
