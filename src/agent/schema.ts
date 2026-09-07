/**
 * The triage decision contract.
 *
 * Two schemas on purpose:
 *
 *  1. `ModelDecisionSchema`  - what the LLM is allowed to say. Enforced by
 *     OpenAI structured outputs AND re-validated here, because "the provider
 *     validated it" is not a guarantee we control.
 *
 *  2. `DecisionSchema`       - what the service emits. It is the model's output
 *     plus fields only the server may set (`requires_human`, `degraded`,
 *     `tools_used`, ...). The model cannot claim it issued a refund or that no
 *     human is needed: those are computed from what actually happened.
 */
import { z } from 'zod';

export const URGENCIES = ['critical', 'high', 'medium', 'low'] as const;
export const NEXT_ACTIONS = ['auto_respond', 'route_to_specialist', 'escalate_to_human'] as const;
export const SENTIMENTS = ['angry', 'frustrated', 'neutral', 'positive'] as const;

// Kept as flat enums rather than free text so downstream systems (routing,
// dashboards, the eval harness) can switch on them. Extending either list is a
// one-line change; see `docs` note in WRITEUP on adding an action.
export const PRODUCT_AREAS = [
  'billing',
  'platform',
  'ui',
  'api',
  'account',
  'integrations',
  'other',
] as const;

export const ISSUE_TYPES = [
  'outage',
  'bug',
  'billing_dispute',
  'question',
  'how_to',
  'feature_request',
  'other',
] as const;

export type Urgency = (typeof URGENCIES)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];

/**
 * Note on `.nullable()` instead of `.optional()`: OpenAI strict structured
 * outputs require every property to be present and listed in `required`.
 * Optionality is therefore expressed as "explicitly null".
 */
export const ModelDecisionSchema = z.strictObject({
  urgency: z.enum(URGENCIES),
  product_area: z.enum(PRODUCT_AREAS),
  /** The dominant issue in the thread. */
  issue_type: z.enum(ISSUE_TYPES),
  /** Other topics raised in the same thread, so a multi-issue ticket is not silently truncated. */
  secondary_topics: z.array(z.string().max(120)).max(3),
  sentiment: z.enum(SENTIMENTS),
  /** ISO 639-1 code of the customer's language, or `und` if undetermined. */
  language: z.string().min(2).max(8),
  next_action: z.enum(NEXT_ACTIONS),
  /** Team name when routing, else null. */
  specialist_team: z.string().max(60).nullable(),
  /** Why this urgency and this action, citing tool evidence. */
  rationale: z.string().min(1).max(1200),
  /** 1-3 sentences addressed to the human operator; this is the chat reply. */
  operator_summary: z.string().min(1).max(800),
  /** Draft reply in the customer's language. Required when auto_responding. */
  customer_reply_draft: z.string().max(4000).nullable(),
});

export type ModelDecision = z.infer<typeof ModelDecisionSchema>;

/** Factual record of one tool invocation, built by the runner - never by the model. */
export const ToolUsedSchema = z.strictObject({
  name: z.string(),
  status: z.enum(['succeeded', 'failed', 'pending_approval', 'denied']),
  side_effect_id: z.string().nullable(),
  error: z.string().nullable(),
});

export const DecisionSchema = ModelDecisionSchema.extend({
  /** True when a human must act before this ticket is resolved. Server-set. */
  requires_human: z.boolean(),
  /** True when triage ran without full information (LLM failure, cap hit). Server-set. */
  degraded: z.boolean(),
  /** Deterministic corrections applied on top of the model's output. Server-set. */
  guard_notes: z.array(z.string()),
  tools_used: z.array(ToolUsedSchema),
  /** Side effects awaiting human approval, e.g. a refund. Server-set. */
  pending_side_effect_ids: z.array(z.string()),
  prompt_version: z.string(),
  model: z.string(),
});

export type Decision = z.infer<typeof DecisionSchema>;
export type ToolUsed = z.infer<typeof ToolUsedSchema>;

// ---------------------------------------------------------------------------
// Customer / ticket input shapes. Declared here (not in the HTTP layer) because
// the agent core owns the domain vocabulary; the API DTOs reuse these.
// ---------------------------------------------------------------------------

export const CustomerProfileSchema = z.strictObject({
  id: z.string().min(1).max(64),
  plan: z.enum(['free', 'pro', 'enterprise']),
  tenure_months: z.number().int().min(0).max(600),
  region: z.string().min(1).max(40),
  seats: z.number().int().min(1).max(100000).optional(),
  prior_tickets: z.number().int().min(0).max(10000),
});

export const TicketMessageSchema = z.strictObject({
  at: z.string().datetime({ offset: true }),
  text: z.string().min(1).max(20000),
});

/**
 * Strict JSON Schema for OpenAI structured outputs / function parameters.
 *
 * `z.toJSONSchema` handles the translation; this wrapper asserts the two
 * invariants OpenAI's strict mode requires, so a schema that would be rejected
 * at runtime fails in our unit tests instead.
 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<
    string,
    unknown
  >;
  assertStrict(json, '$');
  return json;
}

function assertStrict(node: unknown, path: string): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if (obj['type'] === 'object') {
    if (obj['additionalProperties'] !== false) {
      throw new Error(`strictJsonSchema: ${path} must set additionalProperties:false (use z.strictObject)`);
    }
    const properties = (obj['properties'] ?? {}) as Record<string, unknown>;
    const required = (obj['required'] ?? []) as string[];
    const missing = Object.keys(properties).filter((k) => !required.includes(k));
    if (missing.length > 0) {
      throw new Error(
        `strictJsonSchema: ${path} has non-required properties [${missing.join(', ')}]; ` +
          'OpenAI strict mode requires every property - use .nullable() instead of .optional()',
      );
    }
    for (const [key, value] of Object.entries(properties)) assertStrict(value, `${path}.${key}`);
  }

  if (obj['type'] === 'array') assertStrict(obj['items'], `${path}[]`);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branch = obj[key];
    if (Array.isArray(branch)) branch.forEach((b, i) => assertStrict(b, `${path}.${key}[${i}]`));
  }
}

/** The response-format contract handed to the LLM on every call. */
export const DECISION_RESPONSE_FORMAT_NAME = 'triage_decision';
