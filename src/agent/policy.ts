/**
 * Autonomy policy.
 *
 * This is the boundary the assignment asks to be explicit in code: what the
 * agent may do alone, and what needs a human. It is a pure function over the
 * tool registry, so every branch is unit-testable without an LLM, a database,
 * or a network.
 *
 * Design note - why the policy reads the descriptor instead of holding its own
 * table: a second list of tool names is a second thing to forget. Autonomy is
 * declared where the tool is defined, and `createToolRegistry` refuses to build
 * a side-effecting tool that has no dedup key. The policy's job is then narrow
 * and total: parse arguments, apply the budget, classify.
 *
 * Design note - why prompt rules are not the control: the model is asked to
 * cooperate (see system.v1.md), but a confused or injected model still cannot
 * move money, because `requires_approval` short-circuits before `execute` is
 * ever reached.
 */
import type { ToolContext, ToolDescriptor, ToolRegistry } from './types';

export type PolicyDecision =
  | { kind: 'allow'; tool: ToolDescriptor; args: unknown; dedupKey?: string }
  | { kind: 'requires_approval'; tool: ToolDescriptor; args: unknown; dedupKey: string }
  | { kind: 'deny'; code: DenyCode; message: string; details?: unknown };

export type DenyCode =
  | 'unknown_tool'
  | 'malformed_arguments'
  | 'invalid_arguments'
  | 'side_effect_budget_exhausted';

export interface EvaluateInput {
  registry: ToolRegistry;
  name: string;
  /** Raw JSON string from the model. Never trusted. */
  rawArgs: string;
  ctx: ToolContext;
  /** Remaining side-effecting calls allowed in this turn. */
  sideEffectBudget: number;
}

export function evaluate(input: EvaluateInput): PolicyDecision {
  const { registry, name, rawArgs, ctx, sideEffectBudget } = input;

  const tool = registry.get(name);
  if (!tool) {
    // Models occasionally invent tools. Denying by default (rather than
    // ignoring) puts the mistake in the transcript where the eval can see it.
    return {
      kind: 'deny',
      code: 'unknown_tool',
      message: `No such tool: ${name}`,
      details: { available: [...registry.keys()] },
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
  } catch {
    return { kind: 'deny', code: 'malformed_arguments', message: 'Arguments were not valid JSON' };
  }

  const parsed = tool.args.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      kind: 'deny',
      code: 'invalid_arguments',
      message: `Arguments failed validation for ${tool.name}`,
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const args = parsed.data;

  if (tool.sideEffecting) {
    // A runaway loop that pages on-call twenty times is a real failure mode, so
    // the budget is enforced here rather than trusted to the prompt.
    if (sideEffectBudget <= 0) {
      return {
        kind: 'deny',
        code: 'side_effect_budget_exhausted',
        message: 'Too many side-effecting tool calls in one turn',
      };
    }
    const dedupKey = tool.dedupKey!(args, ctx);
    return tool.autonomy === 'requires_approval'
      ? { kind: 'requires_approval', tool, args, dedupKey }
      : { kind: 'allow', tool, args, dedupKey };
  }

  return { kind: 'allow', tool, args };
}

/** Human-readable summary of the boundary, for the README and the audit endpoint. */
export function describePolicy(registry: ToolRegistry): Array<{
  tool: string;
  autonomy: string;
  side_effecting: boolean;
}> {
  return [...registry.values()].map((tool) => ({
    tool: tool.name,
    autonomy: tool.autonomy,
    side_effecting: tool.sideEffecting,
  }));
}
