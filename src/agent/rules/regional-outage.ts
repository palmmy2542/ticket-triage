/**
 * Deterministic paging rule.
 *
 * Why this is code and not a prompt rule: across live eval runs the model wrote
 * "confirming a real regional outage" in its rationale and then returned
 * `escalate_to_human` having paged nobody, treating incident management as the
 * job of whoever picked up the escalation. Three separate prompt levers moved
 * that from 0% to 100%, which is the shape of a reliability ceiling rather than
 * a wording problem. Whether an on-call engineer is woken up should not depend
 * on a sampling temperature.
 *
 * The rule: if our own probes report the CUSTOMER'S region as degraded or
 * failing, an incident exists. No multi-user heuristic is needed - a region
 * serves many customers, so degraded regional probe data IS multi-user impact.
 * A single user on a healthy region (sample ticket 7) does not match, which is
 * the case this rule must not fire on.
 */
import type { ToolCallRecord } from '../runner';

export interface RegionalOutage {
  region: string;
  state: string;
  apiErrorRate: number | null;
  affectedServices: string[];
  /** The tool call this conclusion was drawn from, for the audit trail. */
  sourceSeq: number;
}

/**
 * Inspect this turn's tool results for probe data about the customer's region.
 *
 * This is the one place in the agent core that knows the shape of a specific
 * tool's response. That coupling is deliberate and contained: a deterministic
 * rule has to read real evidence, and keeping it in a named module means the
 * runner does not grow tool-specific knowledge.
 */
export function detectRegionalOutage(
  records: ToolCallRecord[],
  customerRegion: string,
): RegionalOutage | null {
  for (const record of records) {
    if (record.toolName !== 'check_service_status' || record.status !== 'succeeded') continue;

    const result = record.result as
      | {
          ok?: boolean;
          region?: string;
          region_probe?: {
            state?: string;
            api_error_rate?: number;
            affected_services?: string[];
          };
        }
      | undefined;

    if (!result?.ok || !result.region_probe) continue;
    // Only the customer's own region. Checking another region tells us nothing
    // about this ticket, and paging on it would be someone else's incident.
    if (result.region !== customerRegion) continue;

    const state = result.region_probe.state;
    if (state !== 'degraded' && state !== 'outage') continue;

    return {
      region: result.region,
      state,
      apiErrorRate: result.region_probe.api_error_rate ?? null,
      affectedServices: result.region_probe.affected_services ?? [],
      sourceSeq: record.seq,
    };
  }

  return null;
}

/** Probe state to incident severity. `outage` wakes someone faster than `degraded`. */
export function severityFor(state: string): 'sev1' | 'sev2' {
  return state === 'outage' ? 'sev1' : 'sev2';
}

/** Deterministic incident text: no model involved, so it is identical every run. */
export function incidentFor(
  outage: RegionalOutage,
  conversationId: string,
): { severity: 'sev1' | 'sev2'; region: string; title: string; summary: string } {
  const services =
    outage.affectedServices.length > 0 ? outage.affectedServices.join(', ') : 'unknown';
  const rate = outage.apiErrorRate === null ? 'unknown' : outage.apiErrorRate.toString();

  return {
    severity: severityFor(outage.state),
    region: outage.region,
    title: `Regional ${outage.state} detected in ${outage.region}`.slice(0, 120),
    summary:
      `Opened automatically by the triage service, not by the agent. Probe data for ` +
      `${outage.region} reports state=${outage.state}, api_error_rate=${rate}, affected services: ` +
      `${services}. Detected while triaging a customer report on conversation ${conversationId}.`,
  };
}
