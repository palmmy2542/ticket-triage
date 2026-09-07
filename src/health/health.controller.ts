import { Controller, Get } from '@nestjs/common';
import { version } from '../../package.json';

@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  // Liveness only — deliberately does NOT query the database or any
  // dependency, so it reflects whether the process itself is up.
  @Get()
  check(): { status: 'ok'; uptime_s: number; version: string } {
    return {
      status: 'ok',
      uptime_s: Math.floor((Date.now() - this.startedAt) / 1000),
      version,
    };
  }
}
