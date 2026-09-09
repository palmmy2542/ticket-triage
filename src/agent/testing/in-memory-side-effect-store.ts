/**
 * In-memory SideEffectStore for unit tests.
 *
 * Mirrors the semantics the Postgres implementation must provide:
 *  - uniqueness on (dedup scope, tool, dedupKey), where the scope is the
 *    conversation id or `global`, per the tool descriptor's `dedupScope`
 *  - a single claim wins; concurrent claimers are told `in_flight`
 *  - a succeeded effect replays instead of re-executing
 *  - a failed effect may be re-claimed (transient failures should be retryable;
 *    the tool's own idempotency key prevents a double execution if the first
 *    attempt actually landed downstream)
 *
 * Keeping this in the repo, next to the port, is deliberate: if the database
 * implementation drifts from these semantics, the shared contract test catches
 * it. That test is `describeSideEffectStoreContract` at the bottom of this
 * file - run against this class by `side-effect-store.spec.ts` in the unit
 * project, and against Postgres by `test/side-effects.e2e-spec.ts`. The claim
 * used to be aspirational; the drift it names (re-claiming a `failed` row) is
 * real and is now one of the cases.
 */
import { randomUUID } from 'node:crypto';

import { createToolRegistry } from '../tools/registry';
import { dedupScopeKeyFor } from '../types';
import type { SideEffectRecord, SideEffectStatus, SideEffectStore, ToolRegistry } from '../types';

interface Row extends SideEffectRecord {
  conversationId: string;
}

export class InMemorySideEffectStore implements SideEffectStore {
  private readonly rows = new Map<string, Row>();

  /**
   * Defaults to the REAL registry rather than to no registry.
   *
   * The dedup scope lives on the tool descriptor, so a store with no registry
   * would have to assume a scope - and assuming 'conversation' is precisely the
   * bug this store is meant to mirror the absence of. Every existing caller
   * (`runner.spec.ts`, the eval harness) constructs this with no arguments, so
   * defaulting is what keeps the fake and Postgres in step for them too.
   */
  constructor(private readonly registry: ToolRegistry = createToolRegistry({ latencyMs: 0 })) {}

  private key(conversationId: string, toolName: string, dedupKey: string): string {
    // Same helper the Postgres store uses to fill `dedup_scope_key`, so "one
    // page per outage" cannot mean one thing here and another in production.
    const scope = dedupScopeKeyFor(this.registry.get(toolName)?.dedupScope, conversationId);
    return `${scope}|${toolName}|${dedupKey}`;
  }

  async requestApproval(input: {
    conversationId: string;
    toolName: string;
    dedupKey: string;
    args: unknown;
  }): Promise<SideEffectRecord> {
    const key = this.key(input.conversationId, input.toolName, input.dedupKey);
    const existing = this.rows.get(key);
    if (existing) return { ...existing };

    const row: Row = {
      id: randomUUID(),
      conversationId: input.conversationId,
      toolName: input.toolName,
      dedupKey: input.dedupKey,
      status: 'pending_approval',
      args: input.args,
    };
    this.rows.set(key, row);
    return { ...row };
  }

  async beginAutonomous(input: {
    conversationId: string;
    toolName: string;
    dedupKey: string;
    args: unknown;
  }): Promise<{ outcome: 'claimed' | 'replayed' | 'in_flight'; record: SideEffectRecord }> {
    const key = this.key(input.conversationId, input.toolName, input.dedupKey);
    const existing = this.rows.get(key);

    if (!existing) {
      const row: Row = {
        id: randomUUID(),
        conversationId: input.conversationId,
        toolName: input.toolName,
        dedupKey: input.dedupKey,
        status: 'executing',
        args: input.args,
      };
      this.rows.set(key, row);
      return { outcome: 'claimed', record: { ...row } };
    }

    if (existing.status === 'succeeded') return { outcome: 'replayed', record: { ...existing } };
    if (existing.status === 'failed') {
      existing.status = 'executing';
      return { outcome: 'claimed', record: { ...existing } };
    }
    return { outcome: 'in_flight', record: { ...existing } };
  }

  async complete(input: {
    id: string;
    status: 'succeeded' | 'failed';
    result: unknown;
  }): Promise<SideEffectRecord> {
    const row = [...this.rows.values()].find((r) => r.id === input.id);
    if (!row) throw new Error(`No side effect ${input.id}`);
    // Only the holder of the claim closes it. Mirrors the conditional UPDATE in
    // `SideEffectsService.settleClaim`: a row that is already terminal has a
    // provider's answer recorded against it, and a second writer arriving late
    // would replace the only copy of a refund_id with its own outcome.
    if (row.status !== 'executing') return { ...row };
    row.status = input.status;
    row.result = input.result;
    return { ...row };
  }

  // --- test helpers ---------------------------------------------------------

  all(): SideEffectRecord[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  byTool(toolName: string): SideEffectRecord[] {
    return this.all().filter((row) => row.toolName === toolName);
  }

  withStatus(status: SideEffectStatus): SideEffectRecord[] {
    return this.all().filter((row) => row.status === status);
  }
}

// ---------------------------------------------------------------------------
// Shared contract over the SideEffectStore port
// ---------------------------------------------------------------------------

export interface SideEffectStoreContract {
  /** Which implementation is under test, for the describe block's name. */
  name: string;
  /**
   * A fresh, EMPTY store.
   *
   * `conversationIds` are every id the returned store will be asked about, so
   * an implementation whose rows carry a foreign key can create the
   * conversations they point at before the suite starts writing.
   */
  make(conversationIds: readonly string[]): Promise<SideEffectStore>;
}

/**
 * The semantics both `SideEffectStore` implementations must share, run against
 * whichever one the caller hands over.
 *
 * This exists because the unit suite - the primary evidence for the autonomy
 * boundary - runs entirely against the in-memory fake, while the Postgres
 * implementation is only exercised by e2e. Two implementations of one port,
 * tested in complete isolation, drift: the fake used to re-claim a `failed` row
 * unconditionally while Postgres does it with a conditional UPDATE, and nothing
 * compared them. Running one suite over both is what makes the fake evidence
 * about production rather than evidence about itself.
 *
 * Deliberately port-only: every state the suite needs is reached through
 * `requestApproval` / `beginAutonomous` / `complete`, never by reaching into a
 * database or a Map. A case that needs an implementation-specific escape hatch
 * is a case that cannot be a shared contract.
 */
export function describeSideEffectStoreContract(contract: SideEffectStoreContract): void {
  // Real registry tool names, not placeholders: dedup scope is resolved from
  // the tool descriptor, so both arms have to look the scope up through the
  // same descriptors. Parameterising these names would let the two arms
  // disagree about the one thing this suite exists to hold in step.
  const GLOBAL_TOOL = 'open_incident'; // dedupScope: 'global', autonomy: auto
  const SCOPED_TOOL = 'issue_refund'; // dedupScope: default, requires_approval

  describe(`SideEffectStore contract (${contract.name})`, () => {
    let convA: string;
    let convB: string;
    let store: SideEffectStore;

    beforeEach(async () => {
      convA = randomUUID();
      convB = randomUUID();
      store = await contract.make([convA, convB]);
    });

    const claim = (conversationId: string, region: string) =>
      store.beginAutonomous({
        conversationId,
        toolName: GLOBAL_TOOL,
        dedupKey: region,
        args: { severity: 'sev2', region },
      });

    const request = (conversationId: string, chargeId: string) =>
      store.requestApproval({
        conversationId,
        toolName: SCOPED_TOOL,
        dedupKey: `cust_1001:${chargeId}`,
        args: { charge_id: chargeId, amount_cents: 2999 },
      });

    it('claims a fresh effect as `executing`, so a crash mid-call leaves evidence', async () => {
      const claimed = await claim(convA, 'us-east-1');
      expect(claimed.outcome).toBe('claimed');
      expect(claimed.record.status).toBe('executing');
      expect(claimed.record.toolName).toBe(GLOBAL_TOOL);
      expect(claimed.record.dedupKey).toBe('us-east-1');
    });

    it('replays a succeeded effect with its stored result instead of executing again', async () => {
      const first = await claim(convA, 'us-west-2');
      await store.complete({
        id: first.record.id,
        status: 'succeeded',
        result: { ok: true, incident_id: 'inc_replay' },
      });

      const second = await claim(convA, 'us-west-2');
      expect(second.outcome).toBe('replayed');
      expect(second.record.id).toBe(first.record.id);
      expect(second.record.result).toEqual({ ok: true, incident_id: 'inc_replay' });
    });

    it('re-claims a failed effect, because a transient downstream failure must stay retryable', async () => {
      const first = await claim(convA, 'eu-west-1');
      await store.complete({
        id: first.record.id,
        status: 'failed',
        result: { ok: false, error: { code: 'downstream_unavailable' } },
      });

      const retry = await claim(convA, 'eu-west-1');
      expect(retry.outcome).toBe('claimed');
      expect(retry.record.id).toBe(first.record.id);
      expect(retry.record.status).toBe('executing');
    });

    it('answers in_flight while another claimer still holds an `executing` row', async () => {
      const first = await claim(convA, 'asia-southeast-1');
      const second = await claim(convA, 'asia-southeast-1');

      expect(first.outcome).toBe('claimed');
      // The whole point of the write-ahead claim: the second caller must NOT
      // execute, and must be told which row is already doing it.
      expect(second.outcome).toBe('in_flight');
      expect(second.record.id).toBe(first.record.id);
      expect(second.record.status).toBe('executing');
    });

    it('never lets a late `complete` overwrite an outcome already recorded', async () => {
      // The write-ahead claim is a LEASE, and more than one process can believe
      // it holds one: the request path executes an approved effect while the
      // reconciler re-drives the same row after its lease looked stale. Both
      // then call `complete`.
      //
      // Whoever writes second must not win. Money has moved by then and the
      // stored result is the only copy of the provider's id, so an unconditional
      // write turns a succeeded refund into a `failed` row with no refund_id -
      // recording "did not happen" about something that did. Both writers are
      // calling the provider with the SAME server-derived key, so the first
      // answer recorded is a true answer; the second is at best a duplicate of
      // it and at worst a lost id.
      const first = await claim(convA, 'eu-central-1');
      await store.complete({
        id: first.record.id,
        status: 'succeeded',
        result: { ok: true, incident_id: 'inc_first_writer' },
      });

      const late = await store.complete({
        id: first.record.id,
        status: 'failed',
        result: { ok: false, error: { code: 'downstream_unavailable' } },
      });

      // Returned as it STANDS, not as the late writer wished it were: the
      // caller's own HTTP answer is built from this.
      expect(late.status).toBe('succeeded');
      expect(late.result).toEqual({ ok: true, incident_id: 'inc_first_writer' });

      const replay = await claim(convA, 'eu-central-1');
      expect(replay.outcome).toBe('replayed');
      expect(replay.record.result).toEqual({ ok: true, incident_id: 'inc_first_writer' });
    });

    it('requestApproval is idempotent while the row is still waiting on a human', async () => {
      const first = await request(convA, 'ch_3f22b');
      expect(first.status).toBe('pending_approval');

      const again = await request(convA, 'ch_3f22b');
      expect(again.id).toBe(first.id);
      expect(again.status).toBe('pending_approval');

      // The other half - a model that asks again AFTER a human decided must get
      // the decision back rather than a fresh approval - is not expressible
      // here: settling a gated row is `SideEffectsService.approve`, not a
      // `SideEffectStore` operation, and the case used to fake it by calling
      // `complete` on a `pending_approval` row, which is a state no caller
      // reaches. B6 in test/side-effects.e2e-spec.ts covers it through the real
      // approval endpoint.
    });

    it('complete does not settle a row that is still waiting on a human', async () => {
      // Defence in depth on the autonomy boundary. `complete` is the runner's
      // write for an effect IT claimed, and the only status it may close is the
      // claim it holds. A bug that handed it a pending id - a stale variable, a
      // mixed-up loop - would otherwise move a human-gated refund straight to
      // `succeeded` with no human anywhere in it.
      const pending = await request(convA, 'ch_3f23c');
      expect(pending.status).toBe('pending_approval');

      const attempted = await store.complete({
        id: pending.id,
        status: 'succeeded',
        result: { ok: true, refund_id: 're_never_approved' },
      });

      expect(attempted.status).toBe('pending_approval');
      expect(attempted.result).toBeUndefined();
      expect((await request(convA, 'ch_3f23c')).status).toBe('pending_approval');
    });

    it(`scopes ${SCOPED_TOOL} per conversation - the same key on another ticket is another row`, async () => {
      const a = await request(convA, 'ch_3f22b');
      const b = await request(convB, 'ch_3f22b');

      // Not a duplicate: the key names whose money moves, and one ticket's
      // approval decision must never answer for another ticket's refund.
      expect(b.id).not.toBe(a.id);
      expect(b.status).toBe('pending_approval');
    });

    it(`scopes ${GLOBAL_TOOL} globally - the same key on another ticket replays the first row`, async () => {
      const a = await claim(convA, 'us-east-1');
      await store.complete({
        id: a.record.id,
        status: 'succeeded',
        result: { ok: true, incident_id: 'inc_global' },
      });

      // One regional outage arrives on as many tickets as it has victims. The
      // second ticket must reuse the incident, not file and page again.
      const b = await claim(convB, 'us-east-1');
      expect(b.outcome).toBe('replayed');
      expect(b.record.id).toBe(a.record.id);
      expect(b.record.result).toEqual({ ok: true, incident_id: 'inc_global' });
    });
  });
}

/** Logger that records events so tests can assert on the audit trail. */
export class RecordingLogger {
  readonly events: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> = [];

  private push(level: string) {
    return (obj: object, msg?: string) =>
      void this.events.push({ level, obj: obj as Record<string, unknown>, msg });
  }

  debug = this.push('debug');
  info = this.push('info');
  warn = this.push('warn');
  error = this.push('error');

  eventNames(): string[] {
    return this.events.map((e) => String(e.obj['event'] ?? ''));
  }

  find(event: string): Record<string, unknown> | undefined {
    return this.events.find((e) => e.obj['event'] === event)?.obj;
  }
}
