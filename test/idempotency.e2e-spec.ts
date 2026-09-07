/**
 * D. Idempotency (HTTP layer) - src/triage/idempotency.interceptor.ts.
 *
 * The `Idempotency-Key` header is the outermost retry-safety layer: a retried
 * POST with the same key and body must replay the original response rather
 * than creating a second conversation or paying for a second LLM call.
 */
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';

import { decisionFixture } from '../src/agent/llm/fake';
import { createTestApp, truncateAll, ticket1, ticket3, type TestApp } from './support/app';

describe('Idempotency (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.prisma);
  });


  const http = () => ctx.app.getHttpAdapter().getInstance();
  const post = (url: string, payload?: object, headers?: Record<string, string>) =>
    http().inject({ method: 'POST', url, payload, headers });
  const json = (res: LightMyRequestResponse) => JSON.parse(res.payload);

  it('D1: replays the identical response and does not call the model twice', async () => {
    ctx.llm.script([
      {
        kind: 'tools',
        calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
      },
      { kind: 'decision', decision: decisionFixture() },
    ]);

    const key = randomUUID();
    const body = ticket3();

    const first = await post('/tickets', body, { 'idempotency-key': key });
    expect(first.statusCode).toBe(201);
    const firstBody = json(first);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const callCountAfterFirst = ctx.llm.callCount;

    const second = await post('/tickets', body, { 'idempotency-key': key });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    const secondBody = json(second);

    expect(secondBody.conversation_id).toBe(firstBody.conversation_id);
    expect(secondBody.turn_id).toBe(firstBody.turn_id);
    expect(ctx.llm.callCount).toBe(callCountAfterFirst); // no second LLM call

    expect(await ctx.prisma.conversation.count()).toBe(1);
    expect(await ctx.prisma.agentTurn.count()).toBe(1);
  });

  it('D2: the same key with a different body is 422 idempotency_key_reused', async () => {
    ctx.llm.script([
      {
        kind: 'tools',
        calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
      },
      { kind: 'decision', decision: decisionFixture() },
    ]);

    const key = randomUUID();
    const first = await post('/tickets', ticket3(), { 'idempotency-key': key });
    expect(first.statusCode).toBe(201);

    const second = await post('/tickets', ticket1(), { 'idempotency-key': key });
    expect(second.statusCode).toBe(422);
    expect(json(second).error.code).toBe('idempotency_key_reused');
  });

  it('D3: two concurrent requests with the same key - exactly one 201, the other 409', async () => {
    ctx.llm.script([
      {
        kind: 'tools',
        calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
      },
      { kind: 'decision', decision: decisionFixture() },
    ]);

    const key = randomUUID();
    const body = ticket3();

    // Block the model call so the first request's row is still `in_progress`
    // in Postgres when the second request's idempotency-key insert races it -
    // deterministic rather than a timing-dependent sleep.
    const release = ctx.llm.blockNext();
    const winner = post('/tickets', body, { 'idempotency-key': key });
    await ctx.llm.waitUntilBlocked();

    const loser = await post('/tickets', body, { 'idempotency-key': key });
    release();
    const winnerRes = await winner;

    expect(winnerRes.statusCode).toBe(201);
    expect(loser.statusCode).toBe(409);
    expect(json(loser).error.code).toBe('request_in_progress');

    expect(await ctx.prisma.conversation.count()).toBe(1);
  });

  it('D4: a handler failure releases the key so a retry is not treated as reused', async () => {
    // Note on scope: runner.ts's agent loop catches every error the LLM can
    // throw (LlmUnavailableError or a plain Error) and converts it into a
    // degraded 201 - it never lets a turn failure surface as a thrown
    // exception (see runner.ts's outer try/catch around the iteration loop).
    // So a scripted LLM error cannot provoke a 5xx through the public API;
    // that failure path is genuinely unreachable from HTTP with this
    // implementation. The ZodBody validation pipe is the reachable case that
    // still exercises the SAME code the LLM-throws scenario would have
    // exercised: the interceptor's `next.handle()` rejects, its `catchError`
    // deletes the `in_progress` idempotency row, and the exception is
    // rethrown as-is (400 validation_failed here rather than 500).
    const key = randomUUID();
    const invalidBody = { customer: { id: 'x' }, messages: [] }; // fails schema

    const failed = await post('/tickets', invalidBody, { 'idempotency-key': key });
    expect(failed.statusCode).toBe(400);

    // The key must have been released: retrying it with a VALID body is
    // treated as a fresh request, not `idempotency_key_reused`.
    ctx.llm.script([
      {
        kind: 'tools',
        calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
      },
      { kind: 'decision', decision: decisionFixture() },
    ]);
    const retried = await post('/tickets', ticket3(), { 'idempotency-key': key });
    expect(retried.statusCode).toBe(201);
    expect(retried.headers['idempotent-replayed']).toBeUndefined();
  });

  it('D5: POST .../messages is also idempotent on a key', async () => {
    ctx.llm.script([
      {
        kind: 'tools',
        calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
      },
      { kind: 'decision', decision: decisionFixture() },
      { kind: 'decision', decision: decisionFixture({ operator_summary: 'Answered.' }) },
    ]);

    const ingest = json(await post('/tickets', ticket3()));
    const key = randomUUID();
    const messageBody = { role: 'operator', content: 'Any update?' };

    const first = await post(`/conversations/${ingest.conversation_id}/messages`, messageBody, {
      'idempotency-key': key,
    });
    expect(first.statusCode).toBe(200);
    const firstTurnId = json(first).turn_id;

    const second = await post(`/conversations/${ingest.conversation_id}/messages`, messageBody, {
      'idempotency-key': key,
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(json(second).turn_id).toBe(firstTurnId);

    expect(await ctx.prisma.agentTurn.count()).toBe(2); // ingest turn + one message turn
  });

  it('D6: a request with no Idempotency-Key still works', async () => {
    ctx.llm.script([
      {
        kind: 'tools',
        calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
      },
      { kind: 'decision', decision: decisionFixture() },
    ]);

    const res = await post('/tickets', ticket3());
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });
});
