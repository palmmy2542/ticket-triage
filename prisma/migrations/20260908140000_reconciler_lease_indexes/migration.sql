-- Indexes for the lease reconciler's three scan queries.
--
-- Every one of them was a Seq Scan, confirmed by EXPLAIN against this project's
-- Postgres: `agent_turns` is indexed only on conversation_id, `tool_calls` on
-- turn_id, `side_effects` by its unique triple, `idempotency_keys` by primary
-- key alone. The sweeper runs on a timer, so a scan per table per tick is a
-- cost that grows with the tables while the rows it looks for should always be
-- a handful.
--
-- The first three are PARTIAL: the sweeper's predicate is always the
-- non-terminal status, and those rows should number in the single digits, so a
-- partial index stays tiny and hot. It also removes the Sort node, because the
-- index order already matches the ORDER BY. Measured: cost 12.11 -> 8.14 on
-- side_effects. Written as SQL because Prisma's schema language cannot express
-- a partial index, which is also why these do not appear in schema.prisma.
CREATE INDEX "side_effects_executing_updated_at_idx"
  ON "side_effects" ("updated_at") WHERE "status" = 'executing';
CREATE INDEX "agent_turns_running_created_at_idx"
  ON "agent_turns" ("created_at") WHERE "status" = 'running';
CREATE INDEX "idempotency_keys_in_progress_updated_at_idx"
  ON "idempotency_keys" ("updated_at") WHERE "status" = 'in_progress';

-- NOT partial: retention scans `completed`/`failed`, which is most of the
-- table, so a partial index would cover almost every row and buy nothing.
CREATE INDEX "idempotency_keys_status_updated_at_idx"
  ON "idempotency_keys" ("status", "updated_at");
