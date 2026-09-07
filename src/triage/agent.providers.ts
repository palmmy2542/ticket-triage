/**
 * Composition root for the agent.
 *
 * The runner takes its LLM client and tool registry as parameters, so the only
 * place that knows about OpenAI, API keys, or mock latency is here. Tests
 * override `LLM_CLIENT` with a scripted fake and get the whole service under
 * deterministic control; production gets the real adapter. Neither the runner
 * nor the tools change.
 */
import { Logger } from 'nestjs-pino';
import type { Provider } from '@nestjs/common';

import { CannedLlm } from '../agent/llm/canned';
import { OpenAiLlm } from '../agent/llm/openai';
import { createToolRegistry } from '../agent/tools/registry';
import type { LlmClient, ToolRegistry } from '../agent/types';
import { env } from '../config/env';
import { toAgentLogger } from './agent-logger';

export const LLM_CLIENT = 'LLM_CLIENT';
export const TOOL_REGISTRY = 'TOOL_REGISTRY';

export const llmClientProvider: Provider = {
  provide: LLM_CLIENT,
  inject: [Logger],
  useFactory: (logger: Logger): LlmClient => {
    if (env.FAKE_LLM) return new CannedLlm();
    return new OpenAiLlm({
      // Validated at boot by config/env: the process refuses to start without
      // a key unless FAKE_LLM is on, so this is not an unchecked assertion.
      apiKey: env.OPENAI_API_KEY!,
      model: env.OPENAI_MODEL,
      timeoutMs: env.LLM_TIMEOUT_MS,
      maxRetries: 1,
      log: toAgentLogger(logger, 'openai'),
    });
  },
};

export const toolRegistryProvider: Provider = {
  provide: TOOL_REGISTRY,
  useFactory: (): ToolRegistry =>
    createToolRegistry({
      latencyMs: env.NODE_ENV === 'test' ? 0 : env.MOCK_TOOL_LATENCY_MS,
    }),
};
