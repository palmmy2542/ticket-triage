import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';
import type { FastifyRequest } from 'fastify';
import { env } from './config/env';
import { PrismaModule } from './db/prisma.module';
import { HealthModule } from './health/health.module';
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
  ],
})
export class AppModule {}
