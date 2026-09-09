/**
 * The judge is itself non-deterministic, so what is tested here is everything
 * around it: what evidence it is shown, what it is NOT shown, and that every
 * way it can fail produces "no verdict" rather than a silent pass.
 */
import { buildEvidence, judgeDraft, VerdictSchema } from './judge';
import { FakeLlm } from '../src/agent/llm/fake';
import { strictJsonSchema } from '../src/agent/schema';
import type { ToolCallRecord } from '../src/agent/runner';
import {
  LlmUnavailableError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from '../src/agent/types';

const record = (
  toolName: string,
  result: unknown,
  overrides: Partial<ToolCallRecord> = {},
): ToolCallRecord => ({
  seq: 1,
  toolName,
  args: {},
  result,
  policyOutcome: 'allowed',
  status: 'succeeded',
  latencyMs: 1,
  ...overrides,
});

const KB = record('search_knowledge_base', {
  ok: true,
  result_count: 1,
  results: [
    {
      id: 'appearance-dark-mode',
      title: 'Dark mode',
      score: 1.2,
      content: 'Dark mode ships in release 4.2.',
    },
  ],
});

/** Returns a canned verdict and captures what it was asked. */
class RecordingJudge implements LlmClient {
  readonly model = 'judge-model';
  requests: LlmRequest[] = [];
  constructor(private readonly verdict: object) {}
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return {
      content: JSON.stringify(this.verdict),
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}

const GROUNDED = {
  grounded: true,
  unsupported_claims: [],
  contradicts_evidence: false,
  reasoning: 'Every claim appears in the article.',
};

describe('buildEvidence', () => {
  it('includes successful read-tool results', () => {
    const evidence = buildEvidence([KB, record('get_customer_account', { ok: true, plan: 'pro' })]);
    expect(evidence).toContain('search_knowledge_base');
    expect(evidence).toContain('get_customer_account');
    expect(evidence).toContain('release 4.2');
  });

  it('tags side effects as actions, carrying their status', () => {
    // So the judge can tell "we filed a refund request" from "we refunded you".
    const refund = record(
      'issue_refund',
      { ok: true, status: 'pending_approval' },
      {
        status: 'pending_approval',
        policyOutcome: 'requires_approval',
      },
    );
    const evidence = buildEvidence([refund]);
    expect(evidence).toContain('<action tool="issue_refund" status="pending_approval">');
    expect(evidence).not.toContain('<evidence tool="issue_refund"');
  });

  it('excludes failed reads and denied actions', () => {
    const failed = record('check_service_status', { ok: false }, { status: 'failed' });
    const denied = record(
      'issue_refund',
      { ok: false },
      { status: 'denied', policyOutcome: 'denied' },
    );
    expect(buildEvidence([failed, denied])).toBe('');
  });
});

/** What the judge was actually asked, without the standing instructions. */
const userTurn = (judge: RecordingJudge): string =>
  judge.requests[0]!.messages.filter((m) => m.role === 'user')
    .map((m) => ('content' in m ? m.content : ''))
    .join('\n');

describe('judgeDraft', () => {
  it('shows the judge the draft and the evidence, but never the model rationale', async () => {
    const judge = new RecordingJudge(GROUNDED);
    await judgeDraft({
      llm: judge,
      draft: 'Dark mode ships in release 4.2.',
      records: [KB],
      ticket: 'Do you support dark mode?',
    });

    const sent = judge.requests[0]!.messages.map((m) => ('content' in m ? m.content : '')).join(
      '\n',
    );
    expect(sent).toContain('<draft_reply>');
    expect(sent).toContain('release 4.2');
    expect(sent).toContain('<ticket>');
    // The rationale would invite the judge to accept the model's own justification.
    expect(sent).not.toContain('rationale');
    // No tools: the judge reads evidence, it does not gather more.
    expect(judge.requests[0]!.tools).toEqual([]);
  });

  it('shows the judge what the service decided, and nothing more of the model', async () => {
    // Measured five times across four rounds: the judge marked "our platform
    // team will investigate" unsupported on tickets the decision had routed to
    // a specialist. It was reading the evidence, which says nothing about who
    // was assigned, and the routing is not in the evidence - it is the
    // decision. Its own calibration case says a promise about what support will
    // do next is grounded, so the instrument disagreed with itself.
    const judge = new RecordingJudge(GROUNDED);
    await judgeDraft({
      llm: judge,
      draft: 'Our platform team will investigate and get back to you.',
      records: [KB],
      ticket: 'I cannot log in.',
      decision: { next_action: 'route_to_specialist', specialist_team: 'platform' },
    });

    // The USER turn specifically: the system prompt explains what a <decision>
    // block is, so asserting over both messages would pass without one.
    const sent = userTurn(judge);
    expect(sent).toContain('<decision>');
    expect(sent).toContain('route_to_specialist');
    expect(sent).toContain('platform');
    // Routing only. The rationale and the operator summary stay out for the
    // same reason as before: they are the model arguing its own case, and a
    // judge that reads them is grading the argument instead of the evidence.
    expect(sent).not.toContain('rationale');
    expect(sent).not.toContain('operator_summary');
  });

  it('omits the decision block when there is no decision to show', async () => {
    // `judgeDraft` is also called by the calibration set, where most cases are
    // a draft and evidence with no routing at all.
    const judge = new RecordingJudge(GROUNDED);
    await judgeDraft({ llm: judge, draft: 'x', records: [KB], ticket: 't' });
    expect(userTurn(judge)).not.toContain('<decision>');
  });

  it('asks for a strict schema the provider will accept', async () => {
    const judge = new RecordingJudge(GROUNDED);
    await judgeDraft({ llm: judge, draft: 'x', records: [KB], ticket: 't' });
    expect(judge.requests[0]!.responseFormat.schema).toEqual(strictJsonSchema(VerdictSchema));
  });

  it('returns the verdict when the judge answers', async () => {
    const judge = new RecordingJudge({
      grounded: false,
      unsupported_claims: ['dark mode ships in 5.0'],
      contradicts_evidence: true,
      reasoning: 'The article says 4.2.',
    });
    const result = await judgeDraft({
      llm: judge,
      draft: 'ships in 5.0',
      records: [KB],
      ticket: 't',
    });
    expect(result.verdict).toMatchObject({ grounded: false, contradicts_evidence: true });
    expect(result.model).toBe('judge-model');
  });

  // Every failure below must produce a null verdict. A judge that could not
  // answer looking like a pass is worse than having no judge.
  it('skips when there is no draft', async () => {
    const result = await judgeDraft({
      llm: new RecordingJudge(GROUNDED),
      draft: null,
      records: [KB],
      ticket: 't',
    });
    expect(result).toMatchObject({ verdict: null, skipped: 'no_draft' });
  });

  it('skips when nothing was gathered to judge against', async () => {
    const result = await judgeDraft({
      llm: new RecordingJudge(GROUNDED),
      draft: 'anything',
      records: [],
      ticket: 't',
    });
    expect(result).toMatchObject({ verdict: null, skipped: 'no_evidence' });
  });

  it('reports judge_unavailable rather than a pass when the provider fails', async () => {
    const broken = new FakeLlm(
      [{ kind: 'error', error: new LlmUnavailableError('timeout') }],
      'judge-model',
    );
    const result = await judgeDraft({ llm: broken, draft: 'x', records: [KB], ticket: 't' });
    expect(result).toMatchObject({ verdict: null, skipped: 'judge_unavailable' });
  });

  it('reports judge_invalid_output for non-JSON and for off-schema JSON', async () => {
    const prose = new FakeLlm([{ kind: 'raw', content: 'Looks fine to me!' }], 'judge-model');
    expect(await judgeDraft({ llm: prose, draft: 'x', records: [KB], ticket: 't' })).toMatchObject({
      verdict: null,
      skipped: 'judge_invalid_output',
    });

    const wrong = new FakeLlm(
      [{ kind: 'raw', content: JSON.stringify({ grounded: 'yes' }) }],
      'judge-model',
    );
    expect(await judgeDraft({ llm: wrong, draft: 'x', records: [KB], ticket: 't' })).toMatchObject({
      verdict: null,
      skipped: 'judge_invalid_output',
    });
  });
});
