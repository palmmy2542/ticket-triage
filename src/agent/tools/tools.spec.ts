/**
 * Unit tests for the mock tool implementations.
 *
 * Every tool is exercised through its `execute` function with a fixed `now`
 * and `latencyMs: 0`, so nothing here depends on the wall clock or real time
 * passing. Business errors (`ok: false`) are asserted as data; only the
 * deterministic infrastructure-failure hooks (`fail-region`, `ch_fail_*`) are
 * asserted as thrown errors.
 */
import { tokenize, scoreDoc, searchKb } from './search-knowledge-base';
import { createToolRegistry, toolDefinitions } from './registry';
import { KB_DOCS } from '../../fixtures/kb';
import type { CustomerProfile, ToolContext } from '../types';

const NOW = new Date('2026-09-07T12:00:00.000Z');

function makeCtx(customer: CustomerProfile, conversationId = 'conv_test'): ToolContext {
  return {
    conversationId,
    customer,
    now: NOW,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

const FREE_CUSTOMER: CustomerProfile = {
  id: 'cust_1001',
  plan: 'free',
  tenure_months: 4,
  region: 'us-east-1',
  prior_tickets: 0,
};

const ENTERPRISE_CUSTOMER: CustomerProfile = {
  id: 'cust_2002',
  plan: 'enterprise',
  tenure_months: 8,
  region: 'asia-southeast-1',
  seats: 45,
  prior_tickets: 0,
};

const registry = createToolRegistry({ latencyMs: 0 });
const ctx = makeCtx(FREE_CUSTOMER);

// Minimal result shapes for the tool payloads this file asserts against, so
// tests can avoid `any` while still reading `unknown` tool.execute() results.
interface AccountCharge {
  id: string;
  amount_cents: number;
  status: string;
  created_at: string;
}
interface AccountOk {
  ok: true;
  plan: string;
  subscription_status: string;
  workspace_release: string;
  charges: AccountCharge[];
}
interface StatusOk {
  ok: true;
  region: string;
  region_probe: { state: string };
  agrees_with_public_page: boolean;
  public_status_page: { summary: string };
}
interface RefundOk {
  ok: true;
  status: string;
  refund_id: string;
}
interface IncidentOk {
  ok: true;
  paged: string[];
  status: string;
  acknowledge_sla_minutes: number;
  incident_id: string;
}

// ---------------------------------------------------------------------------
// search_knowledge_base
// ---------------------------------------------------------------------------

describe('search_knowledge_base - pure helpers', () => {
  it('ranks appearance-dark-mode first for a dark-mode-toggle query', () => {
    const results = searchKb('dark mode toggle', 5);
    expect(results[0]!.id).toBe('appearance-dark-mode');
  });

  it('ranks a billing doc first for a payment/duplicate-charge query', () => {
    const results = searchKb('payment failed duplicate charge', 5);
    // Either billing doc is an acceptable top hit per the spec; what matters is
    // that a billing doc - not an unrelated one - wins.
    expect(['billing-payment-failed', 'billing-upgrade-not-applied']).toContain(results[0]!.id);
  });

  it('orders results by descending score, and every returned score is > 0', () => {
    const results = searchKb('billing charge payment plan', 5);
    expect(results.length).toBeGreaterThan(1);
    for (const r of results) expect(r.score).toBeGreaterThan(0);
    const scores = results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('returns no matches for a query with no lexical overlap with the KB', () => {
    expect(searchKb('quantum entanglement pricing', 5)).toEqual([]);
  });

  it('produces no tokens (and no matches) for stopwords alone - the scorer is lexical, not semantic', () => {
    expect(tokenize('how do I get the')).toEqual([]);
    expect(searchKb('how do I get the', 5)).toEqual([]);
  });

  it('a Thai ticket query still surfaces platform-error-500, but only via the embedded ASCII words - a documented trade-off, not a bug', () => {
    // Sample ticket text: "ระบบเข้าไม่ได้ครับ ขึ้น error 500" (the system is
    // inaccessible, showing error 500). The tokenizer splits on anything that
    // is not a Unicode letter/number; Thai combining vowel and tone marks are
    // NOT in the \p{L} category, so the Thai run itself fragments into several
    // meaningless pieces (verified directly below) that match nothing in the
    // English KB. The query nonetheless finds `platform-error-500`, but purely
    // because the literal ASCII substrings "error" and "500" happen to be
    // embedded in the same string - not because the tokenizer or the KB
    // understand Thai. This is the KB's stated trade-off (see the comment on
    // `scoreDoc`): lexical, English-only matching.
    const thaiTicket = 'ระบบเข้าไม่ได้ครับ ขึ้น error 500';
    const tokens = tokenize(thaiTicket);
    expect(tokens).toContain('error');
    expect(tokens).toContain('500');
    // The Thai run is not preserved as one clean token - it fragments.
    expect(tokens).not.toContain('ระบบเข้าไม่ได้ครับ');

    const results = searchKb(thaiTicket, 5);
    expect(results.map((r) => r.id)).toEqual(['platform-error-500']);
  });

  it('scoreDoc returns 0 for an empty query token list regardless of doc content', () => {
    const doc = KB_DOCS.find((d) => d.id === 'appearance-dark-mode')!;
    expect(scoreDoc(doc, [])).toBe(0);
  });
});

describe('search_knowledge_base - tool', () => {
  const tool = registry.get('search_knowledge_base')!;

  it('defaults to 3 results when limit is null', async () => {
    const result = (await tool.execute(
      { query: 'billing charge payment plan export', limit: null },
      ctx,
    )) as {
      result_count: number;
      results: unknown[];
    };
    expect(result.result_count).toBe(3);
    expect(result.results).toHaveLength(3);
  });

  it('returns exactly 1 result when limit is 1', async () => {
    const result = (await tool.execute({ query: 'dark mode toggle', limit: 1 }, ctx)) as {
      result_count: number;
      results: unknown[];
    };
    expect(result.result_count).toBe(1);
    expect(result.results).toHaveLength(1);
  });

  it('returns an empty, non-error result for a query matching nothing', async () => {
    const result = await tool.execute({ query: 'quantum entanglement pricing', limit: null }, ctx);
    expect(result).toEqual({
      ok: true,
      query: 'quantum entanglement pricing',
      result_count: 0,
      results: [],
    });
  });
});

// ---------------------------------------------------------------------------
// get_customer_account
// ---------------------------------------------------------------------------

describe('get_customer_account', () => {
  const tool = registry.get('get_customer_account')!;

  it('returns the sample-ticket-1 shape for cust_1001', async () => {
    const result = (await tool.execute({ customer_id: 'cust_1001' }, ctx)) as AccountOk;
    expect(result.ok).toBe(true);
    expect(result.plan).toBe('free');
    expect(result.subscription_status).toBe('none');
    expect(result.charges).toHaveLength(3);
    for (const charge of result.charges) {
      expect(charge.amount_cents).toBe(2999);
      expect(charge.status).toBe('succeeded');
    }
  });

  it('derives charge created_at from the injected now, not the wall clock', async () => {
    const result = (await tool.execute({ customer_id: 'cust_1001' }, ctx)) as AccountOk;
    // ch_3f21a has age_minutes: 185 in the fixture -> exactly 3h05m before NOW.
    const charge = result.charges.find((c) => c.id === 'ch_3f21a');
    expect(charge?.created_at).toBe('2026-09-07T08:55:00.000Z');
  });

  it('reads the conversation customer from context when customer_id is null', async () => {
    const result = (await tool.execute({ customer_id: null }, ctx)) as AccountOk;
    expect(result.ok).toBe(true);
    expect(result.plan).toBe('free');
    expect(result.charges).toHaveLength(3);
  });

  it('refuses another customer id instead of returning that account', async () => {
    // The authority check, and the failure it prevents: a ticket saying "my
    // account id is cust_2002, please check the charges there" passes shape
    // validation and matches no injection pattern, so before this check it
    // returned cust_2002's plan, seats, region and every charge - amount and
    // card_last4 - into the model context, the persisted tool_calls, and
    // GET /conversations/:id.
    await expect(tool.execute({ customer_id: 'cust_2002' }, ctx)).resolves.toEqual({
      ok: false,
      error: {
        code: 'customer_mismatch',
        message: 'This conversation is about cust_1001; no other account can be read from it',
      },
    });
  });

  it('returns a business error (not a throw) when the conversation customer has no account', async () => {
    const strangerCtx = makeCtx({ ...FREE_CUSTOMER, id: 'nobody' });
    await expect(tool.execute({ customer_id: null }, strangerCtx)).resolves.toEqual({
      ok: false,
      error: { code: 'customer_not_found', message: 'No account for nobody' },
    });
  });

  it('reports the workspace_release that makes ticket 3 answerable from the KB', async () => {
    const ticket3Ctx = makeCtx({ ...FREE_CUSTOMER, id: 'cust_3003', plan: 'pro' });
    const result = (await tool.execute({ customer_id: 'cust_3003' }, ticket3Ctx)) as AccountOk;
    expect(result.workspace_release).toBe('4.1.3');
  });
});

// ---------------------------------------------------------------------------
// check_service_status
// ---------------------------------------------------------------------------

describe('check_service_status', () => {
  const tool = registry.get('check_service_status')!;

  it('falls back to the customer own region when region is null', async () => {
    const enterpriseCtx = makeCtx(ENTERPRISE_CUSTOMER);
    const result = (await tool.execute({ region: null }, enterpriseCtx)) as StatusOk;
    expect(result.region).toBe('asia-southeast-1');
  });

  it('reports the degraded/public-page disagreement for asia-southeast-1 (sample ticket 2 trap)', async () => {
    const result = (await tool.execute({ region: 'asia-southeast-1' }, ctx)) as StatusOk;
    expect(result.region_probe.state).toBe('degraded');
    expect(result.agrees_with_public_page).toBe(false);
    // The public page is human-maintained and lags: it still claims health while
    // the regional probe disagrees. This is the exact evidence-discipline trap
    // the system prompt warns about.
    expect(result.public_status_page.summary).toBe('All systems operational');
  });

  it('reports operational and agreeing for us-east-1', async () => {
    const result = (await tool.execute({ region: 'us-east-1' }, ctx)) as StatusOk;
    expect(result.region_probe.state).toBe('operational');
    expect(result.agrees_with_public_page).toBe(true);
  });

  it('returns an unknown_region business error listing known regions, without throwing', async () => {
    const result = await tool.execute({ region: 'mars-1' }, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'unknown_region',
        known_regions: ['us-east-1', 'us-west-2', 'eu-west-1', 'asia-southeast-1'],
      },
    });
  });

  it('throws DownstreamUnavailableError for the deterministic failure hook', async () => {
    await expect(tool.execute({ region: 'fail-region' }, ctx)).rejects.toThrow(/unavailable/);
    await expect(tool.execute({ region: 'fail-region' }, ctx)).rejects.toMatchObject({
      name: 'DownstreamUnavailableError',
    });
  });
});

// ---------------------------------------------------------------------------
// issue_refund
// ---------------------------------------------------------------------------

describe('issue_refund', () => {
  const tool = registry.get('issue_refund')!;
  /** Calls the tool the way the runner does: with the key its own dedupKey derived. */
  const exec = (
    a: { charge_id: string; amount_cents: number; currency: string; reason: string },
    c = ctx,
  ) => tool.execute(a, c, tool.dedupKey!(a, c));
  const args = (chargeId: string, amount = 2999) => ({
    charge_id: chargeId,
    amount_cents: amount,
    currency: 'USD',
    reason: 'Duplicate of ch_3f21a; same amount charged twice within the hour.',
  });

  it('descriptor requires human approval, is side-effecting, and dedups on customer + charge', () => {
    expect(tool.autonomy).toBe('requires_approval');
    expect(tool.sideEffecting).toBe(true);
    expect(tool.dedupKey!(args('ch_3f22b'), ctx)).toBe('cust_1001:ch_3f22b');
    // The customer comes from context, so the same charge id under a different
    // conversation customer is a different key: the key names whose money moves.
    expect(tool.dedupKey!(args('ch_3f22b'), makeCtx(ENTERPRISE_CUSTOMER))).toBe(
      'cust_2002:ch_3f22b',
    );
  });

  it('derives the refund id from the dedup key, so two scopes are two operations', async () => {
    // The dedup key is `<customer>:<charge>`, so the provider's idempotency key
    // has to be that too. While the refund id followed the bare charge id, our
    // uniqueness scope and the provider's were different scopes - and a
    // provider that dedups on the key we send would have collapsed two
    // customers' refunds of the same charge id into one operation.
    const own = (await tool.execute(args('ch_3f21a'), ctx, 'cust_1001:ch_3f21a')) as RefundOk;
    const otherScope = (await tool.execute(
      args('ch_3f21a'),
      ctx,
      'cust_9999:ch_3f21a',
    )) as RefundOk;

    expect(own.refund_id).not.toBe(otherScope.refund_id);
    // ...and the same key is the same operation, which is the half that makes a
    // retried approval safe rather than a second refund.
    const retried = (await tool.execute(args('ch_3f21a'), ctx, 'cust_1001:ch_3f21a')) as RefundOk;
    expect(retried.refund_id).toBe(own.refund_id);
  });

  it('executes as a pending_settlement refund for ch_3f22b', async () => {
    const result = (await exec(args('ch_3f22b'))) as RefundOk;
    expect(result.ok).toBe(true);
    expect(result.status).toBe('pending_settlement');
    expect(typeof result.refund_id).toBe('string');
  });

  it('is idempotent: same charge_id yields the identical refund_id; a different charge_id yields a different one', async () => {
    const first = (await exec(args('ch_3f22b'))) as RefundOk;
    const second = (await exec(args('ch_3f22b'))) as RefundOk;
    expect(second.refund_id).toBe(first.refund_id);

    const other = (await exec(args('ch_3f21a'))) as RefundOk;
    expect(other.refund_id).not.toBe(first.refund_id);
  });

  it('reports already_refunded for a charge that was already refunded in the fixtures', async () => {
    // ch_done_002 belongs to cust_9999, so the check runs under that customer's
    // context - the charge is only visible from the conversation that owns it.
    const providerTestCtx = makeCtx({ ...FREE_CUSTOMER, id: 'cust_9999', plan: 'pro' });
    await expect(tool.execute(args('ch_done_002', 1000), providerTestCtx)).resolves.toMatchObject({
      ok: false,
      error: { code: 'already_refunded' },
    });
  });

  it('reports charge_not_found for a nonexistent charge', async () => {
    await expect(tool.execute(args('ch_nope'), ctx)).resolves.toMatchObject({
      ok: false,
      error: { code: 'charge_not_found' },
    });
  });

  it('refuses a charge that belongs to another account, with the same error as a charge that does not exist', async () => {
    // ch_7b55p is a real, succeeded, refundable charge - on cust_3003's card.
    // Before the ownership check this returned ok:true from a cust_1001
    // conversation, which is a fileable, one-click-approvable refund of a
    // stranger's money; nothing downstream would have caught it. The error code
    // deliberately matches `ch_nope` above so the tool is not an oracle for
    // which charge ids exist elsewhere.
    await expect(tool.execute(args('ch_7b55p'), ctx)).resolves.toEqual({
      ok: false,
      error: { code: 'charge_not_found', message: 'Charge ch_7b55p does not exist' },
    });
    // ...and the same call from the conversation that does own it succeeds.
    const ownerCtx = makeCtx({ ...FREE_CUSTOMER, id: 'cust_3003', plan: 'pro' });
    await expect(exec(args('ch_7b55p'), ownerCtx)).resolves.toMatchObject({ ok: true });
  });

  it('reports amount_exceeds_charge when the requested amount is larger than the charge', async () => {
    await expect(tool.execute(args('ch_3f21a', 999_999), ctx)).resolves.toMatchObject({
      ok: false,
      error: { code: 'amount_exceeds_charge' },
    });
  });

  it('throws DownstreamUnavailableError for ch_fail_001', async () => {
    // The deterministic provider-failure hook is checked before ownership, so
    // this path stays reachable from any conversation.
    await expect(tool.execute(args('ch_fail_001', 1000), ctx)).rejects.toMatchObject({
      name: 'DownstreamUnavailableError',
    });
  });
});

// ---------------------------------------------------------------------------
// open_incident
// ---------------------------------------------------------------------------

describe('open_incident', () => {
  const tool = registry.get('open_incident')!;
  /** Calls the tool the way the runner does: with the key its own dedupKey derived. */
  const exec = (
    a: { severity: 'sev1' | 'sev2' | 'sev3'; region: string; title: string; summary: string },
    c = ctx,
  ) => tool.execute(a, c, tool.dedupKey!(a, c));
  const args = (
    region: string,
    severity: 'sev1' | 'sev2' | 'sev3',
    title = 'Regional API failures',
  ) => ({
    severity,
    region,
    title,
    summary: 'A summary long enough to pass the contract check for this incident severity level.',
  });

  it('descriptor is auto, side-effecting, and dedups on region', () => {
    expect(tool.autonomy).toBe('auto');
    expect(tool.sideEffecting).toBe(true);
    expect(tool.dedupKey!(args('us-east-1', 'sev2'), ctx)).toBe('us-east-1');
  });

  it('dedups GLOBALLY, because a region is not a per-conversation identity', () => {
    // The dedup key is the region, but the store scoped uniqueness by
    // conversation, so the composite key was (conversation, tool, region): one
    // incident per region *per ticket*. A real regional outage arrives on fifty
    // tickets, so that filed fifty `side_effects` rows and made fifty provider
    // calls for one outage. `issue_refund` must NOT follow: its key names whose
    // money moves, and an unscoped refund key would let one customer's refund
    // replay another's stored result.
    expect(tool.dedupScope).toBe('global');
    expect(registry.get('issue_refund')!.dedupScope ?? 'conversation').toBe('conversation');
  });

  it('pages the regional on-call and reports the right SLA per severity', async () => {
    const sev1 = (await exec(args('us-east-1', 'sev1'))) as IncidentOk;
    expect(sev1.paged).toEqual(['oncall-platform-us-east-1']);
    expect(sev1.status).toBe('open');
    expect(sev1.acknowledge_sla_minutes).toBe(5);

    const sev2 = (await exec(args('us-east-1', 'sev2'))) as IncidentOk;
    expect(sev2.acknowledge_sla_minutes).toBe(15);
  });

  it('same region + same title yields the same incident_id; a different region yields a different one', async () => {
    const first = (await exec(args('us-east-1', 'sev2', 'Same title'))) as IncidentOk;
    const second = (await exec(args('us-east-1', 'sev2', 'Same title'))) as IncidentOk;
    expect(second.incident_id).toBe(first.incident_id);

    const otherRegion = (await exec(args('us-west-2', 'sev2', 'Same title'))) as IncidentOk;
    expect(otherRegion.incident_id).not.toBe(first.incident_id);
  });

  it('derives the incident id from the dedup key, so one region is one page however it is titled', async () => {
    // The provider's idempotency key has to be the key the SERVER derived, not
    // whatever the model wrote. `title` is free text, so during a real regional
    // outage fifty tickets produce fifty differently-worded titles for one
    // incident - and if the id follows the title, that is fifty pages to the
    // same on-call rotation for the same outage.
    const dedupKey = tool.dedupKey!(args('asia-southeast-1', 'sev2'), ctx);

    const first = (await tool.execute(
      args('asia-southeast-1', 'sev2', 'Regional degraded detected in asia-southeast-1'),
      ctx,
      dedupKey,
    )) as IncidentOk;
    const second = (await tool.execute(
      args('asia-southeast-1', 'sev2', 'SEA customers cannot load the workspace'),
      ctx,
      dedupKey,
    )) as IncidentOk;

    expect(second.incident_id).toBe(first.incident_id);
  });

  it('refuses to page a region we have no rotation for, listing the known ones', async () => {
    // `region` is both the dedup key and the rotation that gets paged, and
    // severity is model-chosen: "oncall-platform-global" is a page nobody
    // receives, which then reads as "an engineer was paged" in the transcript.
    // check_service_status already made this check; the tool that wakes people
    // did not.
    const result = await tool.execute(args('global', 'sev1'), ctx);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'unknown_region',
        known_regions: ['us-east-1', 'us-west-2', 'eu-west-1', 'asia-southeast-1'],
      },
    });
  });

  it('refuses to page at all when it was given no dedup key', async () => {
    // A side-effecting tool inventing its own idempotency key is how the key we
    // derive and the key the provider sees drift apart: issue_refund's dedup key
    // became `<customer>:<charge>` while its refund_id stayed on the bare charge
    // id, and nothing failed. The registry already refuses to build a
    // side-effecting tool with no dedupKey; this is the other half - refusing to
    // RUN one without the key that dedupKey produced.
    await expect(tool.execute(args('us-east-1', 'sev2'), ctx)).rejects.toThrow(/dedup key/i);
  });

  it('rejects a sev1 page with a summary shorter than 40 chars', async () => {
    const result = await tool.execute(
      {
        severity: 'sev1',
        region: 'eu-west-1',
        title: 'Title here',
        summary: 'too short to page anyone',
      },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'summary_too_thin' } });
  });

  it('throws for the fail-region hook', async () => {
    await expect(tool.execute(args('fail-region', 'sev2'), ctx)).rejects.toMatchObject({
      name: 'DownstreamUnavailableError',
    });
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe('createToolRegistry / toolDefinitions', () => {
  it('exposes exactly the five expected tool names', () => {
    expect([...registry.keys()].sort()).toEqual(
      [
        'search_knowledge_base',
        'get_customer_account',
        'check_service_status',
        'issue_refund',
        'open_incident',
      ].sort(),
    );
  });

  it('produces one definition per tool with a non-empty description and strict-mode parameters', () => {
    const defs = toolDefinitions(registry);
    expect(defs).toHaveLength(registry.size);
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.parameters['additionalProperties']).toBe(false);
    }
  });

  it('declares a dedupKey for every side-effecting tool in the registry', () => {
    for (const tool of registry.values()) {
      if (tool.sideEffecting) {
        expect(typeof tool.dedupKey).toBe('function');
      }
    }
  });
});
