/**
 * Scriptable LLM client for e2e tests.
 *
 * Wraps `FakeLlm` (src/agent/llm/fake.ts) behind a stable instance that survives
 * `.script(...)` calls, so `AppModule`'s `LLM_CLIENT` provider can be overridden
 * ONCE per test app while individual specs re-script the model turn by turn.
 *
 * Also provides deterministic concurrency control for the race tests, so none of
 * them is a sleep-and-hope:
 *
 *  - `blockNext` / `waitUntilBlocked` order TWO requests: block the model call,
 *    fire a second HTTP request, then release - the second request is guaranteed
 *    to arrive while the first is still in flight.
 *  - `barrier(n)` lines N requests up at the same point and releases them
 *    together, for the tests that need N turns committing at once.
 */
import { FakeLlm, type FakeStep } from '../../src/agent/llm/fake';
import type { LlmClient, LlmRequest, LlmResponse } from '../../src/agent/types';

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

export class ScriptableLlm implements LlmClient {
  readonly model = 'fake-gpt';

  private fake: FakeLlm | null = null;
  private pendingGate: Gate | null = null;
  private blockedSignal: Gate | null = null;
  private barrierState: { remaining: number; gate: Gate } | null = null;

  /** Install a fresh scripted model. Call this at the start of every test. */
  script(steps: FakeStep[]): void {
    this.fake = new FakeLlm(steps, this.model);
  }

  /** Every request the model has seen so far this script, in order. */
  get requests(): LlmRequest[] {
    return this.currentFake().requests;
  }

  /** Number of `complete()` calls served so far this script. */
  get callCount(): number {
    return this.fake?.callCount ?? 0;
  }

  /**
   * Makes the NEXT `complete()` call block until the function this returns is
   * invoked. Consumed exactly once - subsequent calls are unaffected until
   * `blockNext()` is called again.
   */
  blockNext(): () => void {
    let resolveGate!: () => void;
    const gatePromise = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    this.pendingGate = { promise: gatePromise, resolve: resolveGate };

    let resolveSignal!: () => void;
    const signalPromise = new Promise<void>((resolve) => {
      resolveSignal = resolve;
    });
    this.blockedSignal = { promise: signalPromise, resolve: resolveSignal };

    return () => resolveGate();
  }

  /**
   * Resolves once the call armed by `blockNext()` has actually been entered
   * (i.e. the request landed and is now paused waiting for release). Await
   * this before firing a second concurrent request, instead of an arbitrary
   * sleep, so the race is deterministic rather than timing-dependent.
   */
  waitUntilBlocked(): Promise<void> {
    if (!this.blockedSignal) {
      throw new Error('ScriptableLlm: waitUntilBlocked() called without a prior blockNext()');
    }
    return this.blockedSignal.promise;
  }

  /**
   * Hold the next `count` model calls until all `count` of them have arrived,
   * then release them together.
   *
   * `blockNext` orders two requests; this one makes N requests reach the SAME
   * point at the same moment, which is what a test needs to exercise what
   * happens when N turns run their closing database transaction concurrently.
   * Still deterministic - the barrier releases on arrival count, never on a
   * timer - and it also pins which scripted step each turn consumes: all `count`
   * first calls are served after the release, so a script whose first `count`
   * steps are identical gives every turn the same shape regardless of the order
   * they win the release.
   *
   * Consumed once: calls after the release run straight through.
   */
  barrier(count: number): void {
    let resolveGate!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    this.barrierState = { remaining: count, gate: { promise, resolve: resolveGate } };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const fake = this.currentFake();

    if (this.barrierState) {
      const barrier = this.barrierState;
      barrier.remaining -= 1;
      if (barrier.remaining <= 0) {
        this.barrierState = null;
        barrier.gate.resolve();
      }
      await barrier.gate.promise;
    }

    if (this.pendingGate) {
      const gate = this.pendingGate;
      const signal = this.blockedSignal;
      this.pendingGate = null;
      this.blockedSignal = null;
      signal?.resolve();
      await gate.promise;
    }

    return fake.complete(request);
  }

  private currentFake(): FakeLlm {
    if (!this.fake) {
      throw new Error(
        'ScriptableLlm: no script installed for this test. Call llm.script([...]) before making a request.',
      );
    }
    return this.fake;
  }
}
