/**
 * D. Idempotency (HTTP layer) - src/triage/idempotency.interceptor.ts.
 *
 * The `Idempotency-Key` header is the outermost retry-safety layer: a retried
 * POST with the same key and body must replay the original response rather
 * than creating a second conversation or paying for a second LLM call.
 */
import { Prisma } from '@prisma/client';
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

  it('D4: a handler failure is terminal on that key and replays, it does not release it', async () => {
    // Behaviour change, deliberate (finding F5c). The interceptor used to
    // DELETE the `in_progress` row on failure so the key could be reused, on
    // the premise that a handler cannot fail after writing durable rows. It
    // can: `runTurnFor` commits conversation.create, agentTurn.create and every
    // side_effects row BEFORE its closing transaction, and that transaction can
    // still fail (lock conflict, P2024 pool timeout, pool closed by a deploy).
    // A released key then let the retry build a SECOND conversation - a fresh
    // side-effect dedup scope, so open_incident pages on-call twice for one
    // outage. The key is now marked `failed` and replayed instead.
    //
    // Note on scope: runner.ts converts every LLM and tool failure into a
    // degraded 201, so a 5xx cannot be provoked through the public API. The
    // ZodBody pipe is the reachable case, and it drives the same interceptor
    // code the 5xx would: `next.handle()` rejects, `catchError` records the
    // failure, and the exception is rethrown as-is (400 here rather than 500).
    const key = randomUUID();
    const invalidBody = { customer: { id: 'x' }, messages: [] }; // fails schema

    const failed = await post('/tickets', invalidBody, { 'idempotency-key': key });
    expect(failed.statusCode).toBe(400);
    expect(json(failed).error.code).toBe('validation_failed');
    expect(failed.headers['idempotent-replayed']).toBeUndefined();

    // Retrying the SAME key with the SAME body replays the identical failure,
    // flagged as a replay, without re-entering the handler.
    const replayed = await post('/tickets', invalidBody, { 'idempotency-key': key });
    expect(replayed.statusCode).toBe(400);
    expect(replayed.headers['idempotent-replayed']).toBe('true');
    expect(json(replayed).error.code).toBe('validation_failed');
    expect(json(replayed).error.details).toEqual(json(failed).error.details);

    // Reusing the key for a DIFFERENT body is still the client bug it always
    // was, and is still answered 422 rather than replayed.
    ctx.llm.script([
      {
        kind: 'tools',
        calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
      },
      { kind: 'decision', decision: decisionFixture() },
    ]);
    const reused = await post('/tickets', ticket3(), { 'idempotency-key': key });
    expect(reused.statusCode).toBe(422);
    expect(json(reused).error.code).toBe('idempotency_key_reused');

    // Nothing durable was written by any of the three attempts, and a FRESH
    // key is the documented way forward.
    expect(await ctx.prisma.conversation.count()).toBe(0);
    const fresh = await post('/tickets', ticket3(), { 'idempotency-key': randomUUID() });
    expect(fresh.statusCode).toBe(201);
  });

  it('D7: a failed attempt leaves a terminal row rather than deleting it (closes the P2025 race)', async () => {
    // `handleExisting` reads the row with `findUniqueOrThrow`. While the error
    // path deleted rows, a loser that arrived between the winner's failure and
    // its delete raised P2025 and surfaced as an unhandled generic 500. Asserted
    // structurally - the row exists, terminal, carrying its status code - because
    // that is what closes the race by construction rather than by handling it.
    const key = randomUUID();
    const failed = await post(
      '/tickets',
      { customer: { id: 'x' }, messages: [] },
      { 'idempotency-key': key },
    );
    expect(failed.statusCode).toBe(400);

    const row = await ctx.prisma.idempotencyKey.findUnique({ where: { key } });
    expect(row).not.toBeNull();
    expect(row?.status).toBe('failed');
    expect(row?.statusCode).toBe(400);
    expect((row?.response as { code?: string } | null)?.code).toBe('validation_failed');
  });

  it('D8: a transient failure with nothing worth replaying answers 409, not the same 500 forever', async () => {
    // The gap D4 left open (finding: transient failures are indistinguishable
    // from fresh ones). A P2024 pool-acquisition timeout is not an
    // HttpException, so `failureSnapshot` has nothing client-visible to store -
    // leaking a driver message into a replayable body would be worse. The key is
    // still terminal (the first attempt already committed a conversation, a turn
    // and its side effects), but replaying a bare 500 made every retry
    // byte-identical to attempt 1, so a caller with exponential backoff on 5xx
    // burned its whole budget on a permanently dead key.
    //
    // Provoked at the real seam rather than through a fake handler: `runTurnFor`
    // commits conversation.create and agentTurn.create, then closes with
    // `prisma.$transaction`. Failing exactly that call reproduces the traced
    // scenario - durable rows already written, non-HttpException error - and is
    // deterministic, no sleeps and no race.
    ctx.llm.script([
      {
        kind: 'tools',
        calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
      },
      { kind: 'decision', decision: decisionFixture() },
    ]);

    const key = randomUUID();
    const body = ticket3();
    const poolTimeout = new Prisma.PrismaClientKnownRequestError(
      'Timed out fetching a new connection from the connection pool',
      { code: 'P2024', clientVersion: Prisma.prismaVersion.client },
    );

    const closingTx = jest.spyOn(ctx.prisma, '$transaction').mockRejectedValueOnce(poolTimeout);
    const first = await post('/tickets', body, { 'idempotency-key': key });
    closingTx.mockRestore();

    expect(first.statusCode).toBe(500);
    expect(json(first).error.code).toBe('internal_error');
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    // Durable rows from the failed attempt: this is why the key is burned
    // rather than released. Releasing it would let the retry build a SECOND
    // conversation, and side-effect dedup is scoped per conversation, so the
    // same outage would page on-call twice.
    expect(await ctx.prisma.conversation.count()).toBe(1);
    const callCountAfterFirst = ctx.llm.callCount;

    // The retry must get a DIFFERENT, terminal answer - a 4xx no retry library
    // treats as retryable - saying the key is spent and a new one is needed.
    const retry = await post('/tickets', body, { 'idempotency-key': key });
    expect(retry.statusCode).toBe(409);
    expect(json(retry).error.code).toBe('idempotency_key_spent');
    expect(json(retry).error.message).toMatch(/new Idempotency-Key/);
    expect(json(retry).error.code).not.toBe(json(first).error.code);

    // Not a replay: the client is being told something new, not handed the
    // recorded response, so the replay header stays off.
    expect(retry.headers['idempotent-replayed']).toBeUndefined();

    // And nothing re-ran: no second LLM call, no second conversation.
    expect(ctx.llm.callCount).toBe(callCountAfterFirst);
    expect(await ctx.prisma.conversation.count()).toBe(1);

    // Structurally: the key is terminal, and what makes the two failure kinds
    // distinguishable is that NOTHING was stored to replay - SQL NULL, not a
    // placeholder body that reads like a real answer.
    const row = await ctx.prisma.idempotencyKey.findUnique({ where: { key } });
    expect(row?.status).toBe('failed');
    expect(row?.statusCode).toBe(500);
    expect(row?.response).toBeNull();

    // Ordering in handleExisting is unchanged: the route/body-hash check still
    // runs BEFORE the status branches, so a different body on this key is the
    // client bug it always was (422) rather than somebody else's failure.
    const reused = await post('/tickets', ticket1(), { 'idempotency-key': key });
    expect(reused.statusCode).toBe(422);
    expect(json(reused).error.code).toBe('idempotency_key_reused');

    // A fresh key is the documented way forward, and it works.
    ctx.llm.script([
      {
        kind: 'tools',
        calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
      },
      { kind: 'decision', decision: decisionFixture() },
    ]);
    const fresh = await post('/tickets', body, { 'idempotency-key': randomUUID() });
    expect(fresh.statusCode).toBe(201);
  });

  it('D9: a failure that DID produce a client-visible response is still replayed verbatim', async () => {
    // The other half of the same branch, pinned so the D8 fix cannot swallow it:
    // a 400/404/422 is a meaningful answer the client can act on, retrying is
    // pointless, and replaying it verbatim (D4) must not turn into a 409.
    const key = randomUUID();
    const invalidBody = { customer: { id: 'x' }, messages: [] };

    const failed = await post('/tickets', invalidBody, { 'idempotency-key': key });
    expect(failed.statusCode).toBe(400);

    const replayed = await post('/tickets', invalidBody, { 'idempotency-key': key });
    expect(replayed.statusCode).toBe(400);
    expect(replayed.headers['idempotent-replayed']).toBe('true');
    expect(json(replayed).error.code).toBe('validation_failed');
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
