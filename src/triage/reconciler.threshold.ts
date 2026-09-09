/**
 * How long a request can legitimately still be in flight, DERIVED rather than
 * picked, and kept in its own file for the same reason `config/env.schema.ts`
 * is: no `env` import, so it is unit-testable without a database or a parsed
 * process environment.
 *
 * There is no wall-clock deadline on a turn anywhere in this system.
 * `LLM_TIMEOUT_MS` is per ATTEMPT, the OpenAI adapter retries once, and
 * `MAX_AGENT_ITERATIONS` bounds the number of model calls - so a single request
 * can legitimately occupy minutes:
 *
 *   30_000ms x 2 attempts x 6 iterations = 360_000ms of model time alone
 *
 * Tool time sits on top of that and has no deadline of its own, which is what
 * `RECONCILE_STALE_MULTIPLIER` (default 2) covers.
 *
 * The error is asymmetric, which is why this is derived and not chosen. Too
 * long only delays recovery. Too short reconciles LIVE work: it hands a running
 * turn a fail-safe decision and re-drives a refund the request is at that
 * moment about to record - strictly worse than the leak being fixed.
 */

/**
 * Attempts the OpenAI adapter makes per model call: one plus its `maxRetries`.
 *
 * Mirrors the `maxRetries: 1` handed to `OpenAiLlm` in `agent.providers.ts`.
 * A constant here because that literal is not configuration today - which is
 * the coupling to fix: the two CAN drift, and if `maxRetries` ever rises
 * without this following, the threshold silently becomes shorter than a legal
 * turn. It should become an env knob that both sites read.
 */
export const LLM_ATTEMPTS_PER_CALL = 1 + 1;

export function deriveStaleAfterMs(config: {
  llmTimeoutMs: number;
  maxIterations: number;
  multiplier: number;
}): number {
  return config.llmTimeoutMs * LLM_ATTEMPTS_PER_CALL * config.maxIterations * config.multiplier;
}

/**
 * The same question asked about ONE PROVIDER CALL rather than a whole turn.
 *
 * A `side_effects` row reaches `executing` immediately before a single call and
 * leaves it immediately after, so the turn bound above - which multiplies in
 * the iteration cap - overstated its lifetime by an order of magnitude. That
 * mattered because the claim holds a dedup key: `open_incident` is globally
 * scoped, so one row stranded by a crash answered `in_flight` to every later
 * ticket reporting the same regional outage, and nobody was paged for as long
 * as the turn bound lasted.
 *
 * Tight is safe HERE and only here, which is the asymmetry worth stating:
 *  - re-driving a side effect early costs nothing, because every result id is a
 *    pure function of the server-derived dedup key (see `redriveSideEffect` and
 *    the registry-wide invariant test), and because both the sweeper's and the
 *    request path's terminal writes are conditional on the claim they hold, so
 *    an early re-drive cannot overwrite a live attempt's answer;
 *  - re-driving a TURN early hands a fail-safe decision to a live request and
 *    is not idempotent at all. That is why the two numbers are separate rather
 *    than one number with a fudge factor.
 *
 * `LLM_TIMEOUT_MS` stands in for a per-call deadline because no tool declares
 * one; the multiplier is the same slack the turn bound uses for tool time.
 */
export function deriveSideEffectStaleAfterMs(config: {
  llmTimeoutMs: number;
  multiplier: number;
}): number {
  return config.llmTimeoutMs * config.multiplier;
}
