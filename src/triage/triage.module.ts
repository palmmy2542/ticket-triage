import { Module } from '@nestjs/common';

import { llmClientProvider, toolRegistryProvider } from './agent.providers';
import { ConversationService } from './conversation.service';
import { ConversationsController } from './conversations.controller';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { SideEffectsService } from './side-effects.service';
import { TicketsController } from './tickets.controller';

@Module({
  controllers: [TicketsController, ConversationsController],
  providers: [
    ConversationService,
    SideEffectsService,
    IdempotencyInterceptor,
    llmClientProvider,
    toolRegistryProvider,
  ],
})
export class TriageModule {}
