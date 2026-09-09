import { z } from 'zod';

import { REGION_STATUS } from '../../fixtures/accounts';
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
  severity: z.enum(['sev1', 'sev2', 'sev3']),
  /**
   * Checked against the known regions in `execute`, the way
   * `check_service_status` does. It is not free text there for good reason: this
   * value is both the dedup key and the rotation that gets paged
   * (`oncall-platform-<region>`), so an invented region ("all", "global",
   * "us-east-9") would page a rotation nobody owns - a page nobody receives,
   * which reads as "handled" in the transcript - and would dedup against
   * nothing, so every retry pages again.
   */
  region: z.string().min(1).max(40),
  title: z.string().min(5).max(120),
  summary: z.string().min(10).max(1000),
});

/** The regions we have probes and an on-call rotation for. */
const KNOWN_REGIONS = REGION_STATUS.map((r) => r.region);

/**
 * Paging side effect, and the one action the agent is allowed to take alone.
 *
 * The asymmetry is the point of the autonomy design: a redundant page costs an
 * engineer a few minutes, while an unpaged regional outage on a 45-seat
 * enterprise account costs the account. Waking a human to ask permission to
 * wake a human is not a safety control.
 *
 * `dedupKey` is the region and `dedupScope` is `global`: one incident per
 * region service-wide, so a model that calls this twice, a retried request, and
 * fifty separate tickets reporting the same outage all page once.
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
      'it again for the same region returns the existing incident instead of paging twice. `region` ' +
      `must be one of the regions we run probes for (${KNOWN_REGIONS.join(', ')}); there is no ` +
      'global or multi-region incident.',
    args: Args,
    autonomy: 'auto',
    sideEffecting: true,
    dedupKey: (args) => args.region,
    // GLOBAL, not per-conversation. The dedup key is the region, and a region
    // is not a property of a ticket: one real regional outage arrives on as
    // many tickets as it has affected customers. Under the store's default
    // conversation scope the effective key was (conversation, open_incident,
    // region), which dedups perfectly inside one ticket and not at all across
    // them - fifty tickets, fifty `side_effects` rows, fifty provider calls for
    // one outage. `issue_refund` deliberately keeps the default: its key names
    // whose money moves, so it must never collide across customers.
    dedupScope: 'global',
    async execute(args, _ctx, dedupKey) {
      await sleep(config.latencyMs);

      if (args.region === 'fail-region') {
        throw new DownstreamUnavailableError('pagerduty', 'gateway timeout');
      }
      // Same allowlist check `check_service_status` already makes, applied here
      // because this is the tool that pages a human: `severity` is model-chosen
      // and `region` selects who gets woken, so neither may be a value we have
      // never heard of. Returned as data (not thrown) so the model can retry
      // with a real region.
      if (!KNOWN_REGIONS.includes(args.region)) {
        return toolError('unknown_region', `No on-call rotation for region ${args.region}`, {
          known_regions: KNOWN_REGIONS,
        });
      }
      if (args.severity === 'sev1' && args.summary.length < 40) {
        // A sev1 page with no detail is worse than no page: the responder has
        // nothing to act on. Cheap contract check a real system would also make.
        return toolError('summary_too_thin', 'sev1 incidents require a substantive summary');
      }

      return {
        ok: true,
        // Keyed on the server-derived dedup key, never on the model-authored
        // title: a real outage produces one incident per region, however many
        // tickets describe it and however differently each one is worded.
        incident_id: stableId('inc', requireDedupKey(dedupKey, 'open_incident'), 10),
        severity: args.severity,
        region: args.region,
        status: 'open',
        paged: [`oncall-platform-${args.region}`],
        acknowledge_sla_minutes: args.severity === 'sev1' ? 5 : 15,
      };
    },
  };
}
