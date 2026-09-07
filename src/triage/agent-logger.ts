/**
 * Adapter from the Nest/pino logger to the agent core's `AgentLogger` port.
 *
 * The agent core must not import NestJS (it is reusable outside HTTP), and pino
 * takes `(obj, msg)` while nestjs-pino's Logger takes `(msg, context)`. Twelve
 * lines here keep that mismatch out of the runner.
 */
import type { Logger } from 'nestjs-pino';

import type { AgentLogger } from '../agent/types';

export function toAgentLogger(logger: Logger, context = 'agent'): AgentLogger {
  const emit =
    (level: 'verbose' | 'log' | 'warn' | 'error') =>
    (obj: object, msg?: string): void => {
      // nestjs-pino forwards the object as structured fields and keeps `msg`
      // as the human-readable line, which is what makes log search work.
      logger[level]({ context, ...obj }, msg ?? '');
    };

  return {
    debug: emit('verbose'),
    info: emit('log'),
    warn: emit('warn'),
    error: emit('error'),
  };
}
