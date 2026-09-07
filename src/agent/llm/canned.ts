/**
 * A model that always returns the same decision and never calls a tool.
 *
 * Used when FAKE_LLM=true, so the service can be booted, exercised with curl,
 * and load-tested without an API key or a cent of spend. It is not a test
 * double for behaviour (that is FakeLlm, which is scripted) - it exists so the
 * transport, persistence, and audit layers can be demonstrated on their own.
 */
import type { LlmClient, LlmRequest, LlmResponse } from '../types';
import { decisionFixture } from './fake';
import type { ModelDecision } from '../schema';

export class CannedLlm implements LlmClient {
  readonly model = 'canned-fake';

  constructor(private readonly decision: ModelDecision = decisionFixture()) {}

  async complete(_request: LlmRequest): Promise<LlmResponse> {
    return {
      content: JSON.stringify(this.decision),
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
