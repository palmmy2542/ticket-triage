/** Small helpers shared by the mock tools. */
import { createHash } from 'node:crypto';

export const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic id derived from the dedup key, so a repeated call with the same
 * key yields the identical id - the guarantee a real Stripe or PagerDuty gives,
 * and the thing our retry tests assert against.
 */
export function stableId(prefix: string, key: string, length = 12): string {
  return `${prefix}_${createHash('sha1').update(key).digest('hex').slice(0, length)}`;
}

/** Expected, business-level failure: returned to the model as data to reason about. */
export function toolError(code: string, message: string, extra: object = {}): object {
  return { ok: false, error: { code, message, ...extra } };
}

/** Unexpected, infrastructure-level failure: thrown, caught by the runner, logged as a failed call. */
export class DownstreamUnavailableError extends Error {
  constructor(service: string, detail: string) {
    super(`${service} unavailable: ${detail}`);
    this.name = 'DownstreamUnavailableError';
  }
}

export interface MockToolConfig {
  /** Simulated round-trip latency. Tests set 0; dev defaults to something realistic. */
  latencyMs: number;
}
