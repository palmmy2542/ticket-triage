/**
 * HTTP request and response contracts.
 *
 * Request schemas reuse the agent core's domain schemas (CustomerProfileSchema,
 * TicketMessageSchema) so the wire format and the model's view of a customer
 * cannot drift apart.
 *
 * Responses are mapped explicitly rather than returning Prisma rows: the
 * database column names are an implementation detail, and leaking them makes
 * every future migration a breaking API change.
 */
import { z } from 'zod';

import { CustomerProfileSchema, TicketMessageSchema, type Decision } from '../agent/schema';

export const IngestTicketSchema = z.strictObject({
  customer: CustomerProfileSchema,
  /** The inbound thread, oldest first. */
  messages: z.array(TicketMessageSchema).min(1).max(50),
});
export type IngestTicketBody = z.infer<typeof IngestTicketSchema>;

export const PostMessageSchema = z.strictObject({
  /**
   * `operator` is a human talking to the agent; `customer` is a new inbound
   * message on the same ticket. Both re-run triage - a fourth angry customer
   * message should be able to change the urgency.
   */
  role: z.enum(['operator', 'customer']).default('operator'),
  content: z.string().min(1).max(20000),
  /**
   * The operator's explicit authorization for this turn to take actions - the
   * button, not the wording.
   *
   * Off by default, because an operator asking "what about the other duplicate
   * charge?" is asking a question, and the phrasing of a question must not be
   * what files a refund. When it is on, a refund is still only FILED: it lands
   * in `pending_approval` and needs the approve endpoint, so this authorizes
   * asking, never spending.
   *
   * Ignored for `role: 'customer'`: an inbound customer message is the work the
   * service was handed, and triaging it is the job.
   */
  authorize_actions: z.boolean().default(false),
  /** Optional client timestamp; defaults to server time. */
  at: z.string().datetime({ offset: true }).optional(),
});
export type PostMessageBody = z.infer<typeof PostMessageSchema>;

// ---------------------------------------------------------------------------
// Response mappers
// ---------------------------------------------------------------------------

export interface TurnResponse {
  conversation_id: string;
  turn_id: string;
  trace_id: string;
  decision: Decision;
  agent_reply: string;
  /** Present when triage ran without full information. */
  degraded: boolean;
}

export interface SideEffectResponse {
  id: string;
  tool: string;
  status: string;
  dedup_key: string;
  args: unknown;
  result: unknown;
  /**
   * What the requester knew, captured when the request was filed.
   *
   * `args` describes the ACTION (charge ch_3f22b, 2999 USD); this describes the
   * DECISION. An operator approving a payment needs to know whose account it
   * is, what we promised them, and why the agent asked - none of which is
   * derivable from a charge id. See `SideEffectsService.decisionContextFor`.
   *
   * Null for rows filed before the column existed.
   */
  decision_context: unknown;
  requested_by_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

type SideEffectRow = {
  id: string;
  toolName: string;
  status: string;
  dedupKey: string;
  args: unknown;
  result: unknown;
  decisionContext: unknown;
  requestedByTurnId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// Single-argument on purpose: `getConversation` maps its rows with
// `.map(toSideEffectResponse)`, so a second parameter here would be handed the
// array index. Anything the mapper needs has to be on the row.
export const toSideEffectResponse = (row: SideEffectRow): SideEffectResponse => ({
  id: row.id,
  tool: row.toolName,
  status: row.status,
  dedup_key: row.dedupKey,
  args: row.args,
  result: row.result ?? null,
  decision_context: row.decisionContext ?? null,
  requested_by_turn_id: row.requestedByTurnId,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});
