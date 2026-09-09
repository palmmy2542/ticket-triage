/**
 * OpenAI adapter.
 *
 * Uses Chat Completions with function tools plus a strict `json_schema`
 * response format. Chat Completions rather than the Responses API because the
 * loop keeps its own message array anyway (see prompt/index.ts: state lives in
 * our database, not in the provider), so the stateful features of Responses buy
 * nothing here while the message-array shape is the most widely understood.
 *
 * Everything provider-specific stops at this file. Swapping models or providers
 * means writing another `LlmClient`; the runner, policy, and tools do not change.
 */
import OpenAI from 'openai';

import {
  LlmUnavailableError,
  type AgentLogger,
  type LlmClient,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
} from '../types';

export interface OpenAiLlmOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Provider-level retries for transient failures. Keep low: the caller has a fail-safe. */
  maxRetries?: number;
  /** Sampling temperature. The judge pins this to 0; triage leaves it at the default. */
  temperature?: number;
  log?: AgentLogger;
}

export class OpenAiLlm implements LlmClient {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiLlmOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries ?? 1,
    });
  }

  get model(): string {
    return this.options.model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();
    this.options.log?.debug(
      {
        event: 'llm.request',
        model: this.model,
        messages: request.messages.length,
        tools: request.tools.length,
      },
      'calling openai',
    );

    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: request.messages.map(toOpenAiMessage),
        tools: request.tools.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: true,
          },
        })),
        tool_choice: 'auto',
        ...(this.options.temperature === undefined
          ? {}
          : { temperature: this.options.temperature }),
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: request.responseFormat.name,
            schema: request.responseFormat.schema,
            strict: true,
          },
        },
      });

      const choice = completion.choices[0];
      if (!choice) throw new LlmUnavailableError('openai returned no choices');

      return {
        content: choice.message.content ?? null,
        toolCalls: (choice.message.tool_calls ?? []).flatMap((call) =>
          call.type === 'function'
            ? [{ id: call.id, name: call.function.name, rawArgs: call.function.arguments }]
            : [],
        ),
        finishReason: choice.finish_reason ?? 'unknown',
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      const status = (error as { status?: number }).status;
      this.options.log?.error(
        { event: 'llm.error', model: this.model, status, latency_ms: Date.now() - startedAt },
        'openai call failed',
      );

      // 4xx that is not a rate limit is our bug (bad schema, bad model name):
      // surfacing it as "unavailable" would hide it behind the fail-safe.
      if (status !== undefined && status < 500 && status !== 429) {
        throw new Error(`openai_request_rejected (${status}): ${(error as Error).message}`);
      }
      throw new LlmUnavailableError((error as Error).message, error);
    }
  }
}

function toOpenAiMessage(message: LlmMessage): OpenAI.Chat.ChatCompletionMessageParam {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: call.rawArgs },
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}
