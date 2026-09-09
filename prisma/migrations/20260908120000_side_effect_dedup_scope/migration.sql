-- Dedup scope for side effects.
--
-- Uniqueness was (conversation_id, tool_name, dedup_key), which is correct for
-- a tool whose dedup identity includes the customer (issue_refund keys on
-- `<customer>:<charge>`) and wrong for one whose identity is fleet-wide.
-- `open_incident` keys on the region, so one real regional outage arriving on
-- N tickets filed N rows and made N provider calls for a single incident.
--
-- The scope moves into its own NOT NULL column instead of making
-- `conversation_id` nullable: Postgres treats NULLs as DISTINCT in a UNIQUE
-- index, so a nullable `conversation_id` would enforce nothing at all for
-- precisely the globally-scoped rows that need enforcing. Keeping
-- `conversation_id` NOT NULL also keeps its foreign key and the
-- `Conversation.sideEffects` relation intact, so a global row is still listed
-- under - and attributable to - the ticket that filed it.

ALTER TABLE "side_effects" ADD COLUMN "dedup_scope_key" TEXT;

-- Backfill with the conversation id, i.e. the scope every existing row was
-- actually deduplicated under. Collapsing historical open_incident rows to
-- 'global' would violate the new unique index the moment two tickets in the
-- backlog reported the same region, and would rewrite what the audit trail says
-- happened. New pages take global scope; old rows keep their history.
UPDATE "side_effects" SET "dedup_scope_key" = "conversation_id";

ALTER TABLE "side_effects" ALTER COLUMN "dedup_scope_key" SET NOT NULL;

DROP INDEX "side_effects_conversation_id_tool_name_dedup_key_key";

CREATE UNIQUE INDEX "side_effects_dedup_scope_key_tool_name_dedup_key_key" ON "side_effects"("dedup_scope_key", "tool_name", "dedup_key");

-- The dropped unique index led on conversation_id and so served every read that
-- filters by it (getConversation, listForConversation). Replace it.
CREATE INDEX "side_effects_conversation_id_idx" ON "side_effects"("conversation_id");
