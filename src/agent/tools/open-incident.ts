import { z } from 'zod';

import type { ToolDescriptor } from '../types';
import {
  DownstreamUnavailableError,
  sleep,
  stableId,
  toolError,
  type MockToolConfig,
} from './support';

const Args = z.strictObject({
  severity: z.enum(['sev1', 'sev2', 'sev3']),
  region: z.string().min(1).max(40),
  title: z.string().min(5).max(120),
  summary: z.string().min(10).max(1000),
});

/**
 * Paging side effect, and the one action the agent is allowed to take alone.
 *
 * The asymmetry is the point of the autonomy design: a redundant page costs an
 * engineer a few minutes, while an unpaged regional outage on a 45-seat
 * enterprise account costs the account. Waking a human to ask permission to
 * wake a human is not a safety control.
 *
 * `dedupKey` is the region: one incident per region per conversation, so a
 * model that calls this twice, or a retried request, pages once.
 */
export function createOpenIncidentTool(config: MockToolConfig): ToolDescriptor<z.infer<typeof Args>> {
  return {
    name: 'open_incident',
    description:
      'Open a platform incident and page the on-call engineer for a region. Use only when evidence ' +
      'shows multi-user or region-wide impact - for example degraded regional probe data plus ' +
      'several independent reports. One incident per region: calling it again for the same region ' +
      'returns the existing incident instead of paging a second time.',
    args: Args,
    autonomy: 'auto',
    sideEffecting: true,
    dedupKey: (args) => args.region,
    async execute(args) {
      await sleep(config.latencyMs);

      if (args.region === 'fail-region') {
        throw new DownstreamUnavailableError('pagerduty', 'gateway timeout');
      }
      if (args.severity === 'sev1' && args.summary.length < 40) {
        // A sev1 page with no detail is worse than no page: the responder has
        // nothing to act on. Cheap contract check a real system would also make.
        return toolError('summary_too_thin', 'sev1 incidents require a substantive summary');
      }

      return {
        ok: true,
        incident_id: stableId('inc', `${args.region}:${args.title}`, 10),
        severity: args.severity,
        region: args.region,
        status: 'open',
        paged: [`oncall-platform-${args.region}`],
        acknowledge_sla_minutes: args.severity === 'sev1' ? 5 : 15,
      };
    },
  };
}
