/**
 * In-memory arm of the shared `SideEffectStore` contract.
 *
 * The other arm runs the SAME suite against Postgres in
 * `test/side-effects.e2e-spec.ts`. Two arms, one suite: the unit suite and the
 * eval both run against this fake, so the fake is only evidence about
 * production for as long as something compares the two.
 */
import { describeSideEffectStoreContract, InMemorySideEffectStore } from './in-memory-side-effect-store';

describeSideEffectStoreContract({
  name: 'InMemorySideEffectStore',
  // No conversation rows to set up: the fake has no foreign key, so the ids the
  // suite generates need nothing created for them first.
  make: async () => new InMemorySideEffectStore(),
});
