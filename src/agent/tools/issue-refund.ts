import { z } from 'zod';

import { ACCOUNTS } from '../../fixtures/accounts';
import type { ToolDescriptor } from '../types';
import {
  DownstreamUnavailableError,
  sleep,
  requireDedupKey,
  stableId,
  toolError,
  type MockToolConfig,
} from './support';

const Args = z.strictObject({
  charge_id: z.string().min(1).max(64),
  amount_cents: z.number().int().min(1).max(10_000_00),
  currency: z.string().length(3),
  /**
   * What a human reads before authorising a payment, so `min(3)` was wrong:
   * "dup" validated. The floor is a sentence because this field and the
   * denormalised decision context are the entire basis of the approval.
   */
  reason: z.string().min(30).max(300),
});

/**
 * Financial side effect. Two properties matter more than the mock behaviour:
 *
 *  1. `autonomy: 'requires_approval'` - the agent can only *request* this. The
 *     runner turns the call into a pending approval row and never reaches
 *     `execute` until a human approves it via the API.
 *
 *  2. `dedupKey` is `<customer>:<charge>`, derived on the server. A refund is
 *     scoped to one charge, so one charge can only ever have one refund request
 *     per conversation, and the payment provider is called with a stable
 *     idempotency key. A retried request, a duplicated approval click, and a
 *     model that calls the tool twice all collapse to a single refund. The
 *     customer id is in the key because the key names whose money moves. To be
 *     precise about what that does and does not buy: a conversation's customer
 *     is written once at ingest and never updated, so there is no reachable
 *     replay-under-a-different-customer bug today. This is defence in depth, and
 *     it makes the key self-describing in the audit trail.
 *
 *  3. The charge is resolved inside `ctx.customer`'s account only - see the
 *     comment in `execute`.
 */
export function createIssueRefundTool(config: MockToolConfig): ToolDescriptor<z.infer<typeof Args>> {
  return {
    name: 'issue_refund',
    description:
      'Request a refund for one specific charge. This does NOT move money: it files a request that ' +
      'a human must approve, and it returns immediately with a pending status. Call it once per ' +
      'charge that should be refunded, with the exact charge id and amount from get_customer_account. ' +
      'Never call it again for the same charge.',
    args: Args,
    autonomy: 'requires_approval',
    sideEffecting: true,
    dedupKey: (args, ctx) => `${ctx.customer.id}:${args.charge_id}`,
    async execute(args, ctx, dedupKey) {
      // Realistic payment-provider latency: slow enough that concurrent
      // approvals interleave, which is what the race tests exercise.
      await sleep(config.latencyMs);

      if (args.charge_id.startsWith('ch_fail')) {
        throw new DownstreamUnavailableError('payments', 'gateway returned 503');
      }

      // Resolved inside THIS conversation's account, never across all accounts.
      // The previous global search meant a ticket that named a stranger's charge
      // ("please refund ch_7b55p") produced ok:true against another customer's
      // card, and the only human in the loop saw a plausible one-click approval
      // with no way to tell whose money it was. `execute` takes `ctx` for this
      // reason: ownership cannot be checked from the arguments alone, and the
      // approval path in side-effects.service.ts calls
      // `tool.execute(row.args, ctx)` with a ctx built from the conversation,
      // so the same check covers a human-approved refund.
      const account = ACCOUNTS.find((a) => a.customer_id === ctx.customer.id);
      const charge = account?.charges.find((c) => c.id === args.charge_id);
      if (!charge) {
        // Deliberately the same error as a charge that does not exist anywhere:
        // a refund attempt must not become an oracle for other accounts' ids.
        return toolError('charge_not_found', `Charge ${args.charge_id} does not exist`);
      }
      if (charge.status === 'refunded') {
        return toolError('already_refunded', `Charge ${args.charge_id} was already refunded`);
      }
      if (charge.status !== 'succeeded') {
        return toolError('charge_not_refundable', `Charge ${args.charge_id} is ${charge.status}`);
      }
      if (args.amount_cents > charge.amount_cents) {
        return toolError('amount_exceeds_charge', 'Refund amount is larger than the charge', {
          charge_amount_cents: charge.amount_cents,
        });
      }

      return {
        ok: true,
        // Keyed on the server-derived dedup key so the provider's idempotency
        // scope is OUR scope. While this followed the bare charge id the two
        // diverged, and a provider deduping on what we send would have treated
        // two customers' refunds of the same charge id as one operation.
        refund_id: stableId('re', requireDedupKey(dedupKey, 'issue_refund')),
        charge_id: args.charge_id,
        amount_cents: args.amount_cents,
        currency: args.currency.toUpperCase(),
        status: 'pending_settlement',
        expected_settlement_days: '5-10 business days',
      };
    },
  };
}
