/**
 * The reconciler is its own module, not a provider inside `TriageModule`.
 *
 * Two reasons, both about direction of dependency: it repairs state the request
 * path left behind, so it must not be able to reach into `ConversationService`
 * or `SideEffectsService` (it works through `PrismaService` and the tool
 * registry only, which is what keeps "the sweeper" and "the handler" from
 * quietly becoming one thing). And it can then be omitted from a deployment -
 * a single sweeping worker alongside N request replicas - by dropping one line
 * from `AppModule` rather than by un-wiring a service.
 *
 * `toolRegistryProvider` is re-declared here rather than exported from
 * `TriageModule`: it is a stateless factory over `env`, so a second instance is
 * identical, and importing the module that owns the request path would defeat
 * the separation above.
 */
import { Module } from '@nestjs/common';

import { toolRegistryProvider } from './agent.providers';
import { ReconcilerService } from './reconciler.service';

@Module({
  providers: [ReconcilerService, toolRegistryProvider],
  exports: [ReconcilerService],
})
export class ReconcilerModule {}
