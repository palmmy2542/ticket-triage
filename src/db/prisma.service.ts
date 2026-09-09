/**
 * Prisma lifecycle, pinned to the one Nest hook that runs late enough.
 *
 * `NestApplicationContext.close()` in the installed @nestjs/core (11.2.3,
 * node_modules/@nestjs/core/nest-application-context.js, lines 119-126) runs, in
 * this order:
 *
 *   callDestroyHook()        -> onModuleDestroy
 *   callBeforeShutdownHook() -> beforeApplicationShutdown
 *   dispose()                -> awaits httpAdapter.close(): stops accepting and
 *                               drains the requests still being served
 *   callShutdownHook()       -> onApplicationShutdown
 *
 * So `$disconnect()` must NOT hang off `onModuleDestroy`. It did, and on SIGTERM
 * that tore the connection pool out from under every in-flight request. One
 * request here is legitimately in flight for seconds to minutes (an LLM turn
 * plus tool calls), so at deploy time that window covers essentially every live
 * turn, not a rare tail.
 *
 * The failure that made this a P1 rather than a tidiness point:
 * `SideEffectsService.approve` had already called the payment provider and was
 * about to write `{ status: 'succeeded', result: { refund_id } }`. The write hit
 * a closed pool, the row stayed `executing` - which has no sweeper and no age
 * check, so it is neither approvable nor rejectable again - and the refund_id
 * was gone. Money moved with no durable record, caused by an ordinary deploy.
 *
 * `onApplicationShutdown` runs after `dispose()`, so the pool now outlives the
 * drain. Nothing else changes: this is still one client for the whole process.
 */
import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
