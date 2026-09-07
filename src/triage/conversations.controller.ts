import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { ZodBody } from '../common/zod-validation.pipe';
import { ConversationService } from './conversation.service';
import { PostMessageSchema, type PostMessageBody, type TurnResponse } from './dto';
import { Idempotent } from './idempotency.interceptor';
import { SideEffectsService } from './side-effects.service';

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly sideEffects: SideEffectsService,
  ) {}

  /** Full history: messages, decisions per turn, tool calls, and side effects. */
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.getConversation(id);
  }

  /** One conversational turn. An operator question or a new customer message. */
  @Post(':id/messages')
  @Idempotent(200)
  postMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ZodBody(PostMessageSchema)) body: PostMessageBody,
  ): Promise<TurnResponse> {
    return this.conversations.addMessage(id, body);
  }

  /**
   * The human half of the autonomy boundary: approve a gated side effect.
   *
   * No `Idempotency-Key` needed. Retry safety comes from the state machine: the
   * conditional UPDATE means only one caller executes, and a later caller is
   * handed the stored result (`replayed: true`) rather than a second refund.
   */
  @Post(':id/side-effects/:sideEffectId/approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sideEffectId', ParseUUIDPipe) sideEffectId: string,
  ) {
    return this.sideEffects.approve(id, sideEffectId, this.conversations.toolRegistry, () =>
      this.conversations.toolContextFor(id),
    );
  }

  @Post(':id/side-effects/:sideEffectId/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sideEffectId', ParseUUIDPipe) sideEffectId: string,
  ) {
    return this.sideEffects.reject(id, sideEffectId);
  }
}
