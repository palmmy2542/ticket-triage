/**
 * Scripted LLM for tests.
 *
 * This is the answer to "how do you test a system whose core is
 * non-deterministic": you make the non-deterministic part injectable, then test
 * everything around it deterministically. The fake lets a test say "the model
 * asks for a refund on these two charges, then returns this decision" and then
 * assert on the parts we own - policy, dedup, persistence, guards, HTTP shapes.
 *
 * Model *quality* is not tested here. That is what the eval harness is for.
 */
import { LlmUnavailableError, type LlmClient, type LlmRequest, type LlmResponse } from '../types';
import type { ModelDecision } from '../schema';

export type FakeStep =
  /** Model asks for tools. */
  | { kind: 'tools'; calls: Array<{ name: string; args: unknown }> }
  /** Model returns a final decision. */
  | { kind: 'decision'; decision: ModelDecision }
  /** Model returns raw content - used to test malformed or off-schema output. */
  | { kind: 'raw'; content: string | null }
  /** Provider failure. */
  | { kind: 'error'; error: Error };

let counter = 0;

export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private index = 0;

  constructor(
    private readonly steps: FakeStep[],
    readonly model = 'fake-gpt',
  ) {}

  get callCount(): number {
    return this.index;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const step = this.steps[this.index++];

    if (!step) {
      throw new Error(`FakeLlm: no scripted step for call ${this.index}. Script more steps.`);
    }

    switch (step.kind) {
      case 'error':
        throw step.error;
      case 'tools':
        return {
          content: null,
          toolCalls: step.calls.map((call) => ({
            id: `call_${++counter}`,
            name: call.name,
            rawArgs: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
          })),
          finishReason: 'tool_calls',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      case 'decision':
        return {
          content: JSON.stringify(step.decision),
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 120, outputTokens: 80 },
        };
      case 'raw':
        return {
          content: step.content,
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 120, outputTokens: 10 },
        };
    }
  }
}

/** Convenience: a valid decision with overrides, so tests state only what they care about. */
export function decisionFixture(overrides: Partial<ModelDecision> = {}): ModelDecision {
  return {
    urgency: 'low',
    product_area: 'ui',
    issue_type: 'question',
    secondary_topics: [],
    sentiment: 'neutral',
    language: 'en',
    next_action: 'auto_respond',
    specialist_team: null,
    rationale: 'Knowledge base article appearance-dark-mode answers this directly.',
    operator_summary: 'Routine question about dark mode; the KB answers it. Draft ready to send.',
    customer_reply_draft: 'Dark mode ships in workspace release 4.2...',
    ...overrides,
  };
}

export const timeoutError = (): LlmUnavailableError =>
  new LlmUnavailableError('Request timed out after 30000ms');
