/**
 * Ports and value types for the agent core.
 *
 * Everything in `src/agent/**` is framework-free: no NestJS, no Prisma, no HTTP.
 * The core depends on these interfaces only, so it can be unit-tested with
 * in-memory fakes and re-hosted (queue worker, CLI, lambda) without changes.
 */
import type { ZodType } from 'zod';

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export type Plan = 'free' | 'pro' | 'enterprise';

export interface CustomerProfile {
  id: string;
  plan: Plan;
  /** How long they have been a customer. Feeds urgency (churn risk). */
  tenure_months: number;
  /** Deployment region, e.g. `asia-southeast-1`. Used to scope status checks. */
  region: string;
  seats?: number;
  prior_tickets: number;
}

/** One message in the inbound customer thread. */
export interface TicketMessage {
  /** ISO 8601. Relative age is what matters for triage, so we render both. */
  at: string;
  text: string;
}

export type ConversationRole = 'customer' | 'operator' | 'agent';

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Logging port (structurally compatible with pino, so the Nest logger passes straight in)
// ---------------------------------------------------------------------------

export interface AgentLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * `auto`               - the agent may execute this itself.
 * `requires_approval`  - the agent may only *request* it; a human decides.
 *
 * The autonomy boundary lives on the descriptor rather than in a separate
 * policy table so that adding a tool is one file and one registry line, and so
 * that a tool can never be added *without* declaring its blast radius.
 */
export type ToolAutonomy = 'auto' | 'requires_approval';

/**
 * How far a `dedupKey` reaches - i.e. which existing rows it can collide with.
 *
 * `conversation` (the default) is right whenever the deduplicated identity
 * belongs to one ticket. `issue_refund` is the case that fixes the default:
 * its key names whose money moves, and an unscoped key would let one
 * customer's refund replay another customer's stored result.
 *
 * `global` is right when the identity is already service-wide. `open_incident`
 * keys on the region, and a region is not a property of a ticket: under
 * conversation scope the effective key was (conversation, tool, region), so one
 * real regional outage arriving on fifty tickets filed fifty `side_effects`
 * rows and made fifty provider calls for a single outage.
 *
 * The scope travels on the descriptor for the same reason `autonomy` does: a
 * tool cannot be added without declaring how wide its dedup identity is, and
 * there is no separate table to forget to update.
 */
export type DedupScope = 'conversation' | 'global';

export interface ToolContext {
  conversationId: string;
  customer: CustomerProfile;
  now: Date;
  log: AgentLogger;
}

// Descriptors are stored type-erased in the registry: a Map cannot hold a
// heterogeneous set of generics. The `any` never escapes unchecked, because
// policy.evaluate re-validates raw arguments against this same `args` schema
// before `execute` is ever reached.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDescriptor<A = any> {
  name: string;
  /** Shown to the model. Say when to call it AND when not to. */
  description: string;
  args: ZodType<A>;
  autonomy: ToolAutonomy;
  /** True if calling it changes the world outside this process. */
  sideEffecting: boolean;
  /**
   * Server-derived deduplication key for side-effecting tools. The model never
   * supplies idempotency keys: a model-chosen key is a model-sized hole in the
   * retry guarantee. Required whenever `sideEffecting` is true.
   */
  dedupKey?: (args: A, ctx: ToolContext) => string;
  /**
   * How wide `dedupKey` dedups. Omitted means `'conversation'`, which is the
   * safe default: a key that turns out to need conversation scoping and is left
   * global cross-contaminates two customers, while one that needs global scope
   * and is left conversational only duplicates work. Defaulting the cheaper
   * mistake is deliberate.
   */
  dedupScope?: DedupScope;
  /**
   * `dedupKey` is the same server-derived key the store uses, handed through so
   * a tool can pass it downstream as the provider's idempotency key. Optional
   * because read-only tools have no key and need none.
   */
  execute: (args: A, ctx: ToolContext, dedupKey?: string) => Promise<unknown>;
}

export type ToolRegistry = ReadonlyMap<string, ToolDescriptor>;

// ---------------------------------------------------------------------------
// Side-effect store port (implemented over Postgres by the triage module)
// ---------------------------------------------------------------------------

export type SideEffectStatus =
  'pending_approval' | 'executing' | 'succeeded' | 'failed' | 'rejected';

/**
 * The `dedup_scope_key` value for a globally-scoped effect.
 *
 * A sentinel in the same column as the conversation id, rather than a NULL:
 * Postgres treats NULLs as DISTINCT in a UNIQUE index, so a nullable scope
 * column enforces nothing for exactly the rows that need enforcing. It cannot
 * collide with a real conversation id because conversation ids are `uuid()`
 * defaults, and `global` is not a UUID.
 */
export const GLOBAL_DEDUP_SCOPE_KEY = 'global';

/**
 * The value a store must dedup against for one (tool, dedupKey) pair.
 *
 * Shared by BOTH SideEffectStore implementations on purpose. This function is
 * the whole difference between "one page per outage" and "one page per ticket",
 * and it is the kind of rule that drifts when each store computes it itself -
 * which is what the shared contract test over this port exists to catch.
 */
export const dedupScopeKeyFor = (scope: DedupScope | undefined, conversationId: string): string =>
  scope === 'global' ? GLOBAL_DEDUP_SCOPE_KEY : conversationId;

export interface SideEffectRecord {
  id: string;
  toolName: string;
  dedupKey: string;
  status: SideEffectStatus;
  args: unknown;
  result?: unknown;
}

export interface SideEffectStore {
  /**
   * Record a request for a human-gated side effect. Idempotent on
   * (dedup scope, tool, dedupKey) - see `dedupScopeKeyFor`: a second request
   * returns the existing row instead of creating a duplicate approval for the
   * same action.
   */
  requestApproval(input: {
    conversationId: string;
    toolName: string;
    dedupKey: string;
    args: unknown;
  }): Promise<SideEffectRecord>;

  /**
   * Write-ahead claim for an autonomous side effect. The row must be committed
   * *before* the external call so a crash mid-call leaves evidence.
   * - `claimed`   -> caller executes the tool, then calls `complete`
   * - `replayed`  -> already done; caller reuses `record.result`
   * - `in_flight` -> another worker holds the claim; caller must not execute
   */
  beginAutonomous(input: {
    conversationId: string;
    toolName: string;
    dedupKey: string;
    args: unknown;
  }): Promise<{ outcome: 'claimed' | 'replayed' | 'in_flight'; record: SideEffectRecord }>;

  complete(input: {
    id: string;
    status: 'succeeded' | 'failed';
    result: unknown;
  }): Promise<SideEffectRecord>;
}

// ---------------------------------------------------------------------------
// LLM port
// ---------------------------------------------------------------------------

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string from the model. Never trusted; parsed against zod. */
  rawArgs: string;
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools: LlmToolDef[];
  /** Strict JSON-schema contract for the final (non-tool) message. */
  responseFormat: { name: string; schema: Record<string, unknown> };
}

export interface LlmResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: string;
  usage?: LlmUsage;
}

export interface LlmClient {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Thrown for timeouts, 5xx, rate limits - anything where the model gave us nothing. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}
