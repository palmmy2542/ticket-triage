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
    // The description is what the model reads at the moment it decides, so the
    // obligation belongs here and not only in the system prompt. Live eval runs
    // showed the model confirming a regional outage in its rationale and then
    // escalating to a human WITHOUT paging - it read "use only when" as a reason
    // to defer, and treated incident management as the job of whoever picks up
    // the escalation. Escalation is a queue; it does not wake anyone up.
    description:
      'Open a platform incident and page the on-call engineer for a region. Call this whenever ' +
      'regional probe data shows a degraded or failing region and more than one person on the ' +
      'account is affected. Do not defer it to the humans you escalate to: escalation only files ' +
      'a ticket, while this is what actually pages an engineer. One incident per region - calling ' +
      'it again for the same region returns the existing incident instead of paging twice.',
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
