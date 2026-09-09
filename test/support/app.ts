/**
 * e2e test harness: build a real Nest app wired to Postgres with the LLM
 * swapped for a `ScriptableLlm`, plus fixture builders for the three sample
 * tickets used across the spec files.
 *
 * Bootstrap style mirrors `test/health.e2e-spec.ts` exactly (FastifyAdapter +
 * AllExceptionsFilter + app.init() + fastify .ready()), the only addition is
 * overriding `LLM_CLIENT` so every spec drives the model deterministically.
 */
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/http-exception.filter';
import { PrismaService } from '../../src/db/prisma.service';
import { LLM_CLIENT } from '../../src/triage/agent.providers';
import type { IngestTicketBody } from '../../src/triage/dto';
import { ScriptableLlm } from './scriptable-llm';

export interface TestApp {
  app: NestFastifyApplication;
  llm: ScriptableLlm;
  prisma: PrismaService;
}

export async function createTestApp(): Promise<TestApp> {
  const llm = new ScriptableLlm();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(LLM_CLIENT)
    .useValue(llm)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const prisma = moduleRef.get(PrismaService);

  return { app, llm, prisma };
}

/**
 * Wipes every row so each test starts clean. FK-safe order: children before
 * parents. `RESTART IDENTITY CASCADE` is belt-and-braces (our ids are UUID
 * defaults, not sequences) and keeps this safe if that ever changes.
 */
export async function truncateAll(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE tool_calls, agent_turns, side_effects, messages, idempotency_keys, conversations RESTART IDENTITY CASCADE',
  );
}

// ---------------------------------------------------------------------------
// Sample tickets
// ---------------------------------------------------------------------------

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

/** cust_1001 - free plan, three real charges (ch_3f21a/22b/23c), angry-by-message-4. */
export function ticket1(): IngestTicketBody {
  return {
    customer: {
      id: 'cust_1001',
      plan: 'free',
      tenure_months: 4,
      region: 'us-east-1',
      prior_tickets: 0,
    },
    messages: [
      {
        at: hoursAgo(9),
        text: 'I was charged three times this month for the Pro upgrade and my account still shows Free.',
      },
      {
        at: hoursAgo(6),
        text: 'This is now the third charge on my card and nothing has changed. Please look into it.',
      },
      {
        at: hoursAgo(3),
        text: 'I have the bank statement showing all three charges, still no Pro access on my workspace.',
      },
      {
        at: hoursAgo(1),
        text:
          'This is unacceptable! I need this fixed by end of day or I am disputing every charge with ' +
          'my bank and cancelling my subscription!',
      },
    ],
  };
}

/** cust_2002 - enterprise, 45 seats, asia-southeast-1 (fixture region is degraded). Thai thread. */
export function ticket2(): IngestTicketBody {
  return {
    customer: {
      id: 'cust_2002',
      plan: 'enterprise',
      tenure_months: 8,
      region: 'asia-southeast-1',
      seats: 45,
      prior_tickets: 0,
    },
    messages: [
      { at: hoursAgo(2), text: 'ระบบขึ้น error 500 ทั้งบริษัทตั้งแต่เมื่อเช้านี้ครับ' },
      {
        at: hoursAgo(1.5),
        text: 'พนักงานหลายคนในทีมเจอปัญหาเดียวกัน หน้าจอว่างเปล่าเข้าใช้งานไม่ได้เลย',
      },
      {
        at: hoursAgo(1),
        text: 'เช็คหน้า status page แล้วบอกว่าระบบปกติดี แต่จริง ๆ ใช้งานไม่ได้เลยครับ',
      },
      {
        at: hoursAgo(0.5),
        text: 'นี่กระทบงานของทีมทั้งหมด 45 seats แล้ว ช่วยเร่งตรวจสอบด่วนด้วยครับ',
      },
    ],
  };
}

/** cust_3003 - pro plan, us-west-2, workspace still on release 4.1.3. Dark-mode thread. */
export function ticket3(): IngestTicketBody {
  return {
    customer: {
      id: 'cust_3003',
      plan: 'pro',
      tenure_months: 5,
      region: 'us-west-2',
      prior_tickets: 0,
    },
    messages: [
      { at: hoursAgo(4), text: "Hi, I can't find a way to turn on dark mode in my workspace." },
      {
        at: hoursAgo(3),
        text: 'Settings > Appearance only shows Light and System Default for me.',
      },
      {
        at: hoursAgo(2),
        text: 'I already tried switching my Mac to dark mode but the app stays light.',
      },
      { at: hoursAgo(1), text: 'Is dark mode available on the Pro plan? Any way to enable it?' },
    ],
  };
}
