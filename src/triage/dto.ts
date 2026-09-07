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
  requestedByTurnId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export const toSideEffectResponse = (row: SideEffectRow): SideEffectResponse => ({
  id: row.id,
  tool: row.toolName,
  status: row.status,
  dedup_key: row.dedupKey,
  args: row.args,
  result: row.result ?? null,
  requested_by_turn_id: row.requestedByTurnId,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});
