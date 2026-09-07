import { Body, Controller, Post } from '@nestjs/common';

import { ZodBody } from '../common/zod-validation.pipe';
import { ConversationService } from './conversation.service';
import { IngestTicketSchema, type IngestTicketBody, type TurnResponse } from './dto';
import { Idempotent } from './idempotency.interceptor';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly conversations: ConversationService) {}

  /**
   * Ingest a ticket thread and run the first triage.
   *
   * Send an `Idempotency-Key` header to make retries safe: the same key returns
   * the original conversation and decision instead of creating a second one.
   */
  @Post()
  @Idempotent(201)
  ingest(@Body(ZodBody(IngestTicketSchema)) body: IngestTicketBody): Promise<TurnResponse> {
    return this.conversations.ingestTicket(body);
  }
}
