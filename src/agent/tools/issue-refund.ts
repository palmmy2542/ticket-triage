import { z } from 'zod';

import { ACCOUNTS } from '../../fixtures/accounts';
import type { ToolDescriptor } from '../types';
import {
  DownstreamUnavailableError,
  sleep,
  stableId,
  toolError,
  type MockToolConfig,
} from './support';

const Args = z.strictObject({
  charge_id: z.string().min(1).max(64),
  amount_cents: z.number().int().min(1).max(10_000_00),
  currency: z.string().length(3),
  reason: z.string().min(3).max(300),
});

/**
 * Financial side effect. Two properties matter more than the mock behaviour:
 *
 *  1. `autonomy: 'requires_approval'` - the agent can only *request* this. The
 *     runner turns the call into a pending approval row and never reaches
 *     `execute` until a human approves it via the API.
 *
 *  2. `dedupKey` is the charge id, derived on the server. A refund is scoped to
 *     one charge, so one charge can only ever have one refund request per
 *     conversation, and the payment provider is called with a stable
 *     idempotency key. A retried request, a duplicated approval click, and a
 *     model that calls the tool twice all collapse to a single refund.
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
    dedupKey: (args) => args.charge_id,
    async execute(args) {
      // Realistic payment-provider latency: slow enough that concurrent
      // approvals interleave, which is what the race tests exercise.
      await sleep(config.latencyMs);

      if (args.charge_id.startsWith('ch_fail')) {
        throw new DownstreamUnavailableError('payments', 'gateway returned 503');
      }

      const charge = ACCOUNTS.flatMap((a) => a.charges).find((c) => c.id === args.charge_id);
      if (!charge) {
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
        refund_id: stableId('re', args.charge_id),
        charge_id: args.charge_id,
        amount_cents: args.amount_cents,
        currency: args.currency.toUpperCase(),
        status: 'pending_settlement',
        expected_settlement_days: '5-10 business days',
      };
    },
  };
}
