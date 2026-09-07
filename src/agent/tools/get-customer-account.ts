import { z } from 'zod';

import { ACCOUNTS } from '../../fixtures/accounts';
import type { ToolDescriptor } from '../types';
import { sleep, toolError, type MockToolConfig } from './support';

const Args = z.strictObject({
  customer_id: z.string().min(1).max(64),
});

export function createGetCustomerAccountTool(
  config: MockToolConfig,
): ToolDescriptor<z.infer<typeof Args>> {
  return {
    name: 'get_customer_account',
    description:
      'Look up an account in the billing system: plan, subscription state, workspace software ' +
      'release, and recent charges with amounts, card, and status. Call this before making any ' +
      'claim about money, plan entitlements, or what the customer was charged.',
    args: Args,
    autonomy: 'auto',
    sideEffecting: false,
    async execute(args, ctx) {
      await sleep(config.latencyMs);
      const account = ACCOUNTS.find((a) => a.customer_id === args.customer_id);
      if (!account) {
        return toolError('customer_not_found', `No account for ${args.customer_id}`);
      }

      const charges = account.charges.map((charge) => ({
        id: charge.id,
        amount_cents: charge.amount_cents,
        currency: charge.currency,
        status: charge.status,
        description: charge.description,
        card_last4: charge.card_last4,
        created_at: new Date(ctx.now.getTime() - charge.age_minutes * 60_000).toISOString(),
      }));

      return {
        ok: true,
        customer_id: account.customer_id,
        plan: account.plan,
        subscription_status: account.subscription_status,
        seats: account.seats,
        tenure_months: account.tenure_months,
        region: account.region,
        workspace_release: account.app_release,
        open_tickets: account.open_tickets,
        charges,
      };
    },
  };
}
