import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new AllExceptionsFilter());

  // Listens for SIGTERM/SIGINT and calls app.close(), which runs
  // onModuleDestroy -> beforeApplicationShutdown -> dispose() (drains the
  // Fastify server) -> onApplicationShutdown. That order is load-bearing:
  // anything that in-flight requests still need - the Prisma pool above all -
  // must be released on `onApplicationShutdown`, AFTER the drain, never on
  // `onModuleDestroy`. See the header of src/db/prisma.service.ts for the
  // refund that got lost when it was the other way round.
  //
  // Deliberately no drain deadline on top: a legitimate turn runs for minutes,
  // so any deadline short enough to be useful would abort exactly the in-flight
  // refund write this ordering exists to protect. The orchestrator's grace
  // period is the bound, and it is the right place for it.
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');
}

bootstrap();
