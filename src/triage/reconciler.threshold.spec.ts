/**
 * The staleness threshold, pinned to its derivation.
 *
 * This is the one number in the reconciler that can do damage if it is wrong,
 * and the damage is asymmetric: too long only delays recovery, while too short
 * reconciles LIVE work - handing a running turn a fail-safe decision and
 * re-driving a refund the request is at that moment about to record.
 *
 * So it is derived, not chosen, and these tests exist to make a future edit to
 * `LLM_TIMEOUT_MS` or `MAX_AGENT_ITERATIONS` flow through instead of silently
 * leaving the threshold behind.
 */
import { deriveSideEffectStaleAfterMs, deriveStaleAfterMs } from './reconciler.threshold';

const defaults = { llmTimeoutMs: 30_000, maxIterations: 6, multiplier: 2 };

describe('deriveStaleAfterMs', () => {
  it('derives the shipped default from the shipped LLM bounds', () => {
    // 30s per ATTEMPT x 2 attempts (the adapter's maxRetries is 1) x 6
    // iterations = 360s of model time a turn may legitimately spend, doubled to
    // cover tool time, which has no deadline of its own.
    expect(deriveStaleAfterMs(defaults)).toBe(720_000);
  });

  it('is never shorter than the worst-case turn it is protecting', () => {
    // The invariant, stated as a test rather than as a comment: whatever the
    // multiplier, the threshold covers every attempt of every iteration. The
    // schema floors the multiplier at 1 for exactly this reason.
    const worstCaseTurnMs = defaults.llmTimeoutMs * 2 * defaults.maxIterations;
    for (const multiplier of [1, 1.5, 2, 10]) {
      expect(deriveStaleAfterMs({ ...defaults, multiplier })).toBeGreaterThanOrEqual(
        worstCaseTurnMs,
      );
    }
  });

  it('tracks a change to the per-attempt timeout', () => {
    expect(deriveStaleAfterMs({ ...defaults, llmTimeoutMs: 60_000 })).toBe(1_440_000);
  });

  it('tracks a change to the iteration cap', () => {
    expect(deriveStaleAfterMs({ ...defaults, maxIterations: 12 })).toBe(1_440_000);
  });
});

/**
 * The SECOND threshold, and why one number was not enough.
 *
 * `deriveStaleAfterMs` bounds a TURN, and a turn is minutes of model time. A
 * side-effect claim is one provider call, so measuring it with the turn's
 * bound left a stranded `executing` row holding its dedup key for 12 minutes -
 * and since `open_incident` is globally scoped, one crashed page silenced
 * every later ticket's page for that region for the whole window.
 */
describe('deriveSideEffectStaleAfterMs', () => {
  it('bounds one provider call, not a whole turn', () => {
    // 30s per attempt x the same multiplier that covers unbounded tool time.
    // An order of magnitude under the turn bound, because iteration count is
    // irrelevant to a single call.
    expect(deriveSideEffectStaleAfterMs(defaults)).toBe(60_000);
    expect(deriveSideEffectStaleAfterMs(defaults)).toBeLessThan(deriveStaleAfterMs(defaults));
  });

  it('does not move when the iteration cap does', () => {
    // The whole point of the split: a longer tool loop does not make a single
    // provider call legitimately slower. The turn bound doubles here; this one
    // must not - it cannot even read the iteration cap.
    const longer = { ...defaults, maxIterations: 12 };
    expect(deriveStaleAfterMs(longer)).toBe(deriveStaleAfterMs(defaults) * 2);
    expect(deriveSideEffectStaleAfterMs(longer)).toBe(deriveSideEffectStaleAfterMs(defaults));
  });

  it('tracks the per-attempt timeout and the multiplier', () => {
    expect(deriveSideEffectStaleAfterMs({ ...defaults, llmTimeoutMs: 60_000 })).toBe(120_000);
    expect(deriveSideEffectStaleAfterMs({ ...defaults, multiplier: 4 })).toBe(120_000);
  });

  it('is never shorter than one full provider attempt', () => {
    // Too short is the dangerous direction here too: it would re-drive a call
    // that is still legitimately in flight. Safe because re-driving is
    // idempotent by the stable-id invariant, but wasteful if it were routine.
    for (const multiplier of [1, 1.5, 2, 10]) {
      expect(deriveSideEffectStaleAfterMs({ ...defaults, multiplier })).toBeGreaterThanOrEqual(
        defaults.llmTimeoutMs,
      );
    }
  });
});
