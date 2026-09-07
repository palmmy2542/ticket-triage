import { z } from 'zod';

import { PUBLIC_STATUS_PAGE, REGION_STATUS } from '../../fixtures/accounts';
import type { ToolDescriptor } from '../types';
import { DownstreamUnavailableError, sleep, toolError, type MockToolConfig } from './support';

const Args = z.strictObject({
  /**
   * Region to check. Null means "the customer's own region", which the tool
   * fills in from context - the model omitting it must not silently become a
   * global check, because the global view is exactly the misleading one.
   */
  region: z.string().min(1).max(40).nullable(),
});

export function createCheckServiceStatusTool(
  config: MockToolConfig,
): ToolDescriptor<z.infer<typeof Args>> {
  return {
    name: 'check_service_status',
    description:
      "Check platform health. Returns the public status page summary alongside machine probe data " +
      "for a single region. Omit `region` to check the customer's own region. The public page is " +
      'human-maintained and can lag a live incident, so prefer the regional probe data when they disagree.',
    args: Args,
    autonomy: 'auto',
    sideEffecting: false,
    async execute(args, ctx) {
      await sleep(config.latencyMs);
      const region = args.region ?? ctx.customer.region;

      // Deterministic infrastructure-failure hook for tests.
      if (region === 'fail-region') {
        throw new DownstreamUnavailableError('status-probe', 'probe cluster unreachable');
      }

      const status = REGION_STATUS.find((r) => r.region === region);
      if (!status) {
        return toolError('unknown_region', `No probe data for region ${region}`, {
          known_regions: REGION_STATUS.map((r) => r.region),
        });
      }

      return {
        ok: true,
        region: status.region,
        region_probe: {
          state: status.state,
          api_error_rate: status.api_error_rate,
          affected_services: status.affected_services,
          active_incident_id: status.active_incident_id,
          probe_age_seconds: status.probe_age_seconds,
          source: 'internal synthetic probes',
        },
        public_status_page: PUBLIC_STATUS_PAGE,
        // Named explicitly so the disagreement is a fact in the transcript, not
        // something the model has to notice on its own.
        agrees_with_public_page: status.state === 'operational',
      };
    },
  };
}
