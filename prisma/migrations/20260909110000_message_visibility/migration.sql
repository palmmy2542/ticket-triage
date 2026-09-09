-- Who each message row was written for.
--
-- `messages` was already an internal record wearing no label: the `agent` rows
-- hold `decision.operator_summary` (a note to the operator), the customer-facing
-- text of the same turn is `customer_reply_draft` on the decision and is never
-- written here at all, and an operator's question sat in the thread looking
-- exactly like the customer conversation around it. Anything reading this table
-- had to infer from `role` whether a row had been seen by the customer.
--
-- Nullable first, then backfilled, then NOT NULL: the table has rows in every
-- environment this ships to, and a NOT NULL column added in one step with a
-- default would silently label all of them.
ALTER TABLE "messages" ADD COLUMN "visibility" TEXT;

-- Backfilled from `role`, which is exactly what the old code meant:
--  * `customer` rows are the conversation the customer is party to;
--  * `operator` rows are internal by construction;
--  * `agent` rows are operator summaries - the reconciler's fail-safe reply
--    included - because nothing in this service has ever sent a customer a
--    message.
UPDATE "messages" SET "visibility" = CASE WHEN "role" = 'customer' THEN 'customer' ELSE 'internal' END;

ALTER TABLE "messages" ALTER COLUMN "visibility" SET NOT NULL;

-- `internal` rather than `customer`, so an unlabelled write fails safe: a row
-- nobody labelled must not claim the customer has seen it.
ALTER TABLE "messages" ALTER COLUMN "visibility" SET DEFAULT 'internal';
