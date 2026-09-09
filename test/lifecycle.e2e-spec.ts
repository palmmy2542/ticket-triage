/**
 * G. Shutdown ordering and concurrent turns on one conversation.
 *
 * Two failures that only appear when something else is happening at the same
 * time - a deploy, or a second operator - and that both destroy durable state
 * rather than just returning an error:
 *
 *  - G1: `$disconnect()` must run AFTER the HTTP server has been disposed.
 *    Hung off `onModuleDestroy` it ran BEFORE, so every deploy tore the
 *    connection pool out from under the requests still being served - including
 *    an approve that had already called the payment provider and was about to
 *    record the refund_id.
 *  - G2: two turns on the same conversation take the same two locks on the
 *    `conversations` row. In the wrong order they deadlock, and the loser's
 *    whole transaction aborts - turn left `running`, tool calls never
 *    persisted, no agent reply - while its side effects, committed outside that
 *    transaction, have already fired.
 */
import type { LightMyRequestResponse } from 'fastify';

import { decisionFixture } from '../src/agent/llm/fake';
import { PrismaService } from '../src/db/prisma.service';
import { createTestApp, truncateAll, ticket3, type TestApp } from './support/app';

const kbCall = {
  kind: 'tools' as const,
  calls: [{ name: 'search_knowledge_base', args: { query: 'dark mode', limit: null } }],
};

describe('Lifecycle and concurrency (e2e)', () => {
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
  const post = (url: string, payload?: object) => http().inject({ method: 'POST', url, payload });
  const get = (url: string) => http().inject({ method: 'GET', url });
  const json = (res: LightMyRequestResponse) => JSON.parse(res.payload);

  it('G1 (F5b): the Prisma pool is closed after the HTTP server is disposed, not before', async () => {
    // Asserted on ORDER rather than on an in-flight request, because
    // light-my-request has no socket for Fastify to drain - there is nothing to
    // observe being cut off. The order is the whole bug: @nestjs/core's
    // `close()` runs callDestroyHook() -> beforeShutdown -> dispose() (which
    // awaits httpAdapter.close()) -> callShutdownHook(). Anything in-flight
    // requests still need must therefore be released on onApplicationShutdown.
    //
    // Both spies call through, so the app really does shut down and leaves no
    // open handle behind.
    const own = await createTestApp();
    const order: string[] = [];

    const prisma = own.app.get(PrismaService);
    const adapter = own.app.getHttpAdapter();
    const realDisconnect = prisma.$disconnect.bind(prisma);
    const realClose = adapter.close.bind(adapter);

    const disconnectSpy = jest.spyOn(prisma, '$disconnect').mockImplementation(async () => {
      order.push('prisma_disconnect');
      return realDisconnect();
    });
    const closeSpy = jest.spyOn(adapter, 'close').mockImplementation(async () => {
      order.push('http_close');
      return realClose();
    });

    try {
      await own.app.close();
      expect(order).toEqual(['http_close', 'prisma_disconnect']);
    } finally {
      disconnectSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('G2 (F5a): four turns committing at once on one conversation all persist, none deadlocks', async () => {
    // The ingest turn is scripted and awaited on its own, so the four
    // concurrent turns start from a known state and consume a known part of the
    // script: their four first calls are all `tools` (which is what makes each
    // closing transaction insert `tool_calls`, the FK rows that take FOR KEY
    // SHARE on the conversation), and their four second calls are all
    // `decision`.
    ctx.llm.script([
      kbCall,
      { kind: 'decision', decision: decisionFixture() },
      kbCall,
      kbCall,
      kbCall,
      kbCall,
      { kind: 'decision', decision: decisionFixture({ operator_summary: 'One.' }) },
      { kind: 'decision', decision: decisionFixture({ operator_summary: 'Two.' }) },
      { kind: 'decision', decision: decisionFixture({ operator_summary: 'Three.' }) },
      { kind: 'decision', decision: decisionFixture({ operator_summary: 'Four.' }) },
    ]);

    const ingest = json(await post('/tickets', ticket3()));
    const conversationId = ingest.conversation_id as string;

    // Release all four model calls together, so all four closing transactions
    // contend for the conversation row at the same moment.
    ctx.llm.barrier(4);
    const responses = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        post(`/conversations/${conversationId}/messages`, {
          role: 'operator',
          content: `Concurrent operator question ${n}`,
        }),
      ),
    );

    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }

    const conv = json(await get(`/conversations/${conversationId}`));

    // Every turn committed its whole closing transaction: no turn left
    // `running`, and every turn has both its tool call and its agent reply.
    expect(conv.turns).toHaveLength(5);
    for (const turn of conv.turns) {
      expect(turn.status).toBe('ok');
      expect(turn.decision).not.toBeNull();
    }

    const turnIdsWithToolCalls = new Set(
      conv.tool_calls.map((call: { turn_id: string }) => call.turn_id),
    );
    expect(turnIdsWithToolCalls.size).toBe(5);

    const agentMessages = conv.messages.filter((m: { role: string }) => m.role === 'agent');
    expect(agentMessages).toHaveLength(5);

    // `seq` is UNIQUE per conversation, so contiguous seqs also prove the
    // lock actually serialised the appends rather than two turns racing to the
    // same number.
    const seqs = conv.messages.map((m: { seq: number }) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]).toBe(seqs.length);
    // Four-way Postgres lock contention plus four LLM-gated turns does not
    // belong on Jest's 5s default: under the inverted lock order this test fails
    // by TIMING OUT rather than by an assertion, and on a loaded CI box that
    // reads as flake instead of the regression it is.
  }, 30_000);
});
