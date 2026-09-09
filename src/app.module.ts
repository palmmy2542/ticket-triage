import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';
import type { FastifyRequest } from 'fastify';
import { env } from './config/env';
import { PrismaModule } from './db/prisma.module';
import { HealthModule } from './health/health.module';
import { ReconcilerModule } from './triage/reconciler.module';
import { TriageModule } from './triage/triage.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        transport:
          env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        genReqId: (req: FastifyRequest) => {
          const existing = req.headers['x-request-id'];
          return typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
        },
        autoLogging: true,
        redact: ['req.headers.authorization'],
      },
    }),
    PrismaModule,
    HealthModule,
    TriageModule,
    // The one pass that gives the three expiry-less leases an expiry:
    // `side_effects.executing`, `agent_turns.running`,
    // `idempotency_keys.in_progress`, plus retention for the last of those.
    // A separate module so a deployment can run it on one worker instead of on
    // every request replica by removing this line - see reconciler.module.ts.
    ReconcilerModule,
  ],
})
export class AppModule {}
