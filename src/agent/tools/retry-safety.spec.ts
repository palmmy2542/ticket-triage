/**
 * The invariant automated recovery is built on, as a test rather than a comment.
 *
 *   every side-effecting tool's result is a pure function of the SERVER-derived
 *   dedup key
 *
 * `ReconcilerService.redriveSideEffect` re-calls a stranded provider call on
 * purpose, and `SideEffectsService.settleClaim` discards a late writer's answer
 * on purpose, and BOTH are only safe because a repeated call with the same key
 * returns the same refund_id. Two files' worth of comments said so; nothing
 * checked it, so a new tool returning `re_${Date.now()}` or a provider-minted
 * id would have passed review and turned every re-drive into a double refund
 * with no way to tell the two apart.
 *
 * `assertRetrySafe` cannot check this at construction time - it would have to
 * call the provider to find out - so the forcing function is here: a
 * side-effecting tool with no probe in this table fails the suite.
 */
import { createToolRegistry } from './registry';
import type { ToolContext } from '../types';

const registry = createToolRegistry({ latencyMs: 0 });

const ctx: ToolContext = {
  conversationId: 'conv_1',
  customer: {
    id: 'cust_1001',
    plan: 'free',
    tenure_months: 4,
    region: 'us-east-1',
    prior_tickets: 0,
  },
  now: new Date('2026-09-07T12:00:00.000Z'),
  log: { debug() {}, info() {}, warn() {}, error() {} },
};

/**
 * One successful call per side-effecting tool, with two dedup keys that a real
 * caller could produce. Both keys must be ones the tool ACCEPTS: a rejected
 * call returns the same `toolError` either way, which would make the
 * discrimination below vacuous.
 */
const probes: Array<{
  tool: string;
  args: unknown;
  keyA: string;
  keyB: string;
}> = [
  {
    tool: 'issue_refund',
    args: {
      charge_id: 'ch_3f22b',
      amount_cents: 2999,
      currency: 'USD',
      reason: 'Duplicate of ch_3f21a; the same amount was charged twice within the hour.',
    },
    keyA: 'cust_1001:ch_3f22b',
    keyB: 'cust_2002:ch_3f22b',
  },
  {
    tool: 'open_incident',
    args: {
      severity: 'sev2',
      region: 'us-east-1',
      title: 'Degraded region us-east-1',
      summary: 'Probe data reports elevated error rates across us-east-1.',
    },
    keyA: 'us-east-1',
    keyB: 'eu-west-1',
  },
];

describe('side-effecting tools are re-drivable', () => {
  it('has a probe for every side-effecting tool in the registry', () => {
    // The forcing function. Adding a side-effecting tool without adding it here
    // fails this test, which is the only place the re-drive premise is checked.
    const sideEffecting = [...registry.values()].filter((t) => t.sideEffecting).map((t) => t.name);
    expect(sideEffecting.sort()).toEqual(probes.map((p) => p.tool).sort());
  });

  for (const probe of probes) {
    it(`${probe.tool}: the same dedup key returns the identical result`, async () => {
      const tool = registry.get(probe.tool)!;
      const first = await tool.execute(probe.args, ctx, probe.keyA);
      const second = await tool.execute(probe.args, ctx, probe.keyA);

      expect(first).toEqual(expect.objectContaining({ ok: true }));
      // Deep equality over the WHOLE result, not just the id field: a timestamp
      // or a sequence number in the payload would be just as unsafe to re-drive
      // as a random id, and naming one field would let the rest drift.
      expect(second).toEqual(first);
    });

    it(`${probe.tool}: a different dedup key returns a different result`, async () => {
      const tool = registry.get(probe.tool)!;
      // The other half. Without it a tool returning a hardcoded id would pass
      // the equality above, and every distinct action would collide on one id.
      const a = await tool.execute(probe.args, ctx, probe.keyA);
      const b = await tool.execute(probe.args, ctx, probe.keyB);
      expect(b).not.toEqual(a);
    });

    it(`${probe.tool}: refuses to run without the server-derived key`, async () => {
      // A tool that invented its own key when the caller passed none would be
      // silently un-redrivable: the id would change per attempt.
      const tool = registry.get(probe.tool)!;
      await expect(tool.execute(probe.args, ctx, undefined)).rejects.toThrow(/dedup key/);
    });
  }
});
