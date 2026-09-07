/**
 * Scriptable LLM client for e2e tests.
 *
 * Wraps `FakeLlm` (src/agent/llm/fake.ts) behind a stable instance that survives
 * `.script(...)` calls, so `AppModule`'s `LLM_CLIENT` provider can be overridden
 * ONCE per test app while individual specs re-script the model turn by turn.
 *
 * Also provides deterministic concurrency control (`blockNext` /
 * `waitUntilBlocked`) for the idempotency and side-effect race tests: rather
 * than a sleep-and-hope race, a test can block the model call, fire a second
 * HTTP request, then release - guaranteeing the second request really does
 * arrive while the first is still in flight.
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

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const fake = this.currentFake();

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
