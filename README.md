# Support Ticket Triage Service

An HTTP service that puts an LLM agent in front of a human support team. It ingests a
ticket thread, classifies it, gathers evidence with tools, decides what should happen
next, and records every step so the decision can be reconstructed afterwards.

The agent is the easy part. The interesting part is the machinery around it: an explicit
autonomy boundary, retry-safe side effects, a fail-safe when the model misbehaves, and a
test strategy that does not depend on the model being deterministic.

## Contents

- [Setup](#setup) · [Environment](#environment) · [API](#api) · [Try it](#try-it-with-curl)
- [Architecture](#architecture) · [Autonomy boundary](#autonomy-boundary) · [Idempotency](#idempotency-and-retry-safety)
- [Testing](#testing) · [Eval harness](#eval-harness) · [Observability](#observability)
- [Design decisions](WRITEUP.md) — the graded write-up, including trade-offs and failure modes
- [Eval findings](eval/FINDINGS.md) — what each round of live measurement changed

## Setup

Requires Node >= 22, pnpm, and Docker.

```bash
cp .env.example .env      # then paste your OPENAI_API_KEY into .env
docker compose up -d db && pnpm install && pnpm db:setup && pnpm start:dev
```

`pnpm db:setup` applies the Prisma migration. The service listens on `http://localhost:3000`.

If host port 5433 is already taken, set `DB_PORT` to a free port in `.env` and update the
port in `DATABASE_URL` to match. Without Docker, point `DATABASE_URL` at any Postgres 14+
and run `pnpm db:setup`.

To run the whole thing with no API key and no spend, set `FAKE_LLM=true`. Every endpoint,
the database, the audit trail, and idempotency work; the model returns one canned decision.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — (required) | Postgres connection string |
| `OPENAI_API_KEY` | — | Required unless `FAKE_LLM=true`. Read from the environment, never committed |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Any OpenAI chat model with tools + structured outputs |
| `FAKE_LLM` | `false` | Run without a key or network |
| `LLM_TIMEOUT_MS` | `30000` | Per-call timeout; one provider retry on top |
| `MAX_AGENT_ITERATIONS` | `6` | Tool-loop cap per turn |
| `MAX_SIDE_EFFECTS_PER_TURN` | `4` | Cap on side-effecting calls in one turn |
| `MOCK_TOOL_LATENCY_MS` | `250` | Simulated downstream latency (forced to 0 in tests) |
| `DB_PORT` | `5433` | Host port for the compose Postgres |
| `PORT`, `LOG_LEVEL`, `NODE_ENV` | `3000`, `info`, `development` | |

Config is parsed once by `src/config/env.ts` and the process refuses to boot on a bad or
incomplete environment, including a missing key when the real model is enabled.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/tickets` | Ingest a thread, run the first triage. `201` |
| `POST` | `/conversations/:id/messages` | One turn: an operator question or a new customer message. `200` |
| | | `authorize_actions: true` lets an operator's turn file actions; off by default |
| `GET` | `/conversations/:id` | Full audit trail: messages, per-turn decisions, tool calls, side effects |
| `POST` | `/conversations/:id/side-effects/:sideEffectId/approve` | Human approves a gated action, e.g. a refund |
| `POST` | `/conversations/:id/side-effects/:sideEffectId/reject` | Human rejects it |
| `GET` | `/health` | Liveness. Does not touch the database |

`POST /tickets` and `POST /conversations/:id/messages` accept an optional `Idempotency-Key`
header. Approve and reject need no key; they are made safe by the state machine instead.

Errors always have the same shape, and never leak a stack or a driver message:

```json
{ "error": { "code": "idempotency_key_reused", "message": "...", "request_id": "req-5" } }
```

| Status | When |
| --- | --- |
| `400` | Request body or path parameter failed validation (`details` carries the field errors) |
| `404` | Unknown conversation or side effect |
| `409` | State conflict: side effect already executing, or a request with that key is in flight |
| `422` | An `Idempotency-Key` was reused for a different body |

A model failure is deliberately **not** a 5xx: the ticket is stored and a degraded
escalation is returned, because losing a support ticket is worse than returning a
low-confidence one. See [Failure modes](WRITEUP.md).

## Try it with curl

```bash
curl -s -X POST localhost:3000/tickets \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{
    "customer": { "id": "cust_1001", "plan": "free", "tenure_months": 4,
                  "region": "us-east-1", "prior_tickets": 0 },
    "messages": [
      { "at": "2026-09-07T09:00:00Z", "text": "My payment failed when I tried to upgrade to Pro." },
      { "at": "2026-09-07T11:00:00Z", "text": "I now have THREE charges of $29.99 and still no Pro access." }
    ]
  }'
```

The response carries `conversation_id`, `turn_id`, `trace_id`, and the structured
`decision`. Repeat the exact same call with the same `Idempotency-Key` and you get the
same conversation back with an `idempotent-replayed: true` header, not a second ticket.

```bash
CONV=<conversation_id from above>

# Ask the agent a follow-up question as an operator. A question re-triages and
# reads whatever it needs, but takes no action: how it is worded is not an
# instruction to move money.
curl -s -X POST localhost:3000/conversations/$CONV/messages \
  -H 'content-type: application/json' \
  -d '{ "role": "operator", "content": "Which charges did you verify, and why not refund all three?" }'

# Authorize this turn to act. A refund is still only FILED for approval, so this
# authorizes asking, never spending.
curl -s -X POST localhost:3000/conversations/$CONV/messages \
  -H 'content-type: application/json' \
  -d '{ "role": "operator", "content": "Refund the other duplicate too.", "authorize_actions": true }'

# Read the audit trail: decisions, tool calls, and anything awaiting approval
curl -s localhost:3000/conversations/$CONV

# Approve a pending refund (id from side_effects above). Safe to call twice.
curl -s -X POST localhost:3000/conversations/$CONV/side-effects/<side_effect_id>/approve
```

The known customer ids in the mock billing system are `cust_1001` (three duplicate
charges), `cust_2002` (enterprise, `asia-southeast-1`), `cust_3003` (Pro, on an old
workspace release), and `cust_9999` (failure-path fixtures).

## Architecture

```
HTTP (NestJS on Fastify)         src/triage/     transport, validation, error envelope,
   │                                             idempotency, approval endpoints
   ├─ ConversationService                        persist first, then run the agent
   ├─ SideEffectsService                         state machine over Postgres
   ↓
Agent core (plain TypeScript)     src/agent/     no NestJS, no Prisma, no HTTP
   ├─ prompt/system.v4.md                        versioned, commented, comments stripped
   ├─ schema.ts                                  the decision contract (zod, strict)
   ├─ tools/                                     descriptor = schema + autonomy + dedup + impl
   ├─ policy.ts                                  pure autonomy decision
   ├─ runner.ts                                  the loop, guards, fail-safe
   └─ llm/ → OpenAiLlm | FakeLlm | CannedLlm     the LlmClient port itself is in types.ts
   ↓
Postgres (Prisma)                 prisma/        conversations, messages, agent_turns,
                                                 tool_calls, side_effects, idempotency_keys
```

The agent core imports nothing from the framework or the database: it receives an
`LlmClient`, a `SideEffectStore`, and a `Logger` as parameters. That is what makes the
tests deterministic and the core reusable from a queue worker or a CLI.

**Adding a tool** is one file plus one line in `tools/registry.ts`. Autonomy and the dedup
rule live on the descriptor, so a side-effecting tool cannot be registered without
declaring how retries are deduplicated — `createToolRegistry` throws otherwise, and the tool
then refuses to run unless it is handed the key that rule produced.

Two places outside the descriptor still key off tool *names* and will not fail if you forget
them: the `tool_command_injection` pattern in `rules/injection.ts`, and `READ_TOOLS` in
`eval/judge.ts`, which re-encodes the `sideEffecting` flag the descriptor already declares. A
useful new tool is usually a prompt edit too, since the prompt names tools explicitly when it
tells the model what evidence to gather.

### Tools

| Tool | Side effect | Autonomy |
| --- | --- | --- |
| `search_knowledge_base` | no | auto |
| `get_customer_account` | no | auto |
| `check_service_status` | no | auto |
| `open_incident` | pages on-call | **auto** |
| `issue_refund` | moves money | **requires human approval** |

All five are mocked but behave like the real thing: simulated latency, structured business
errors returned as data, infrastructure failures thrown, stable ids for a repeated
idempotency key, and a status page that disagrees with the regional probes because real
status pages lag real incidents.

## Autonomy boundary

The agent may **never** move money. `issue_refund` does not issue a refund; it files a
`pending_approval` row and returns that to the model. Only `POST .../approve` executes it.
Opening an incident, which pages a human, **is** allowed autonomously: a redundant page
costs an engineer a few minutes, while an unpaged regional outage on a 45-seat enterprise
account costs the account.

This is enforced in code, not in the prompt (`src/agent/policy.ts`), so a jailbroken,
injected, or simply confused model cannot cross it. The prompt asks the model to
cooperate; the policy makes cooperation optional.

On top of that, `runner.ts` applies deterministic guards after every turn: a critical
ticket is never auto-answered, a ticket with a pending approval is never auto-answered, an
`auto_respond` with no draft text is escalated, and `tools_used` is rebuilt from what
actually executed — so the model cannot claim a refund it did not get. "A ticket with a
pending approval" means the ticket, not the turn: a refund filed by turn 1 and still waiting
on a human is what turn 5 must not answer over, and the count is read per conversation
rather than derived from one turn's tool calls.

**A question is not an instruction.** An operator's natural-language message re-triages and
reads freely, but may not act: `issue_refund` and `open_incident` are denied with
`side_effects_not_authorized`, and the turn is asked to name the action it believes is
needed instead. Acting is a separate, explicit act — `authorize_actions: true`, the button —
because otherwise the phrasing of a question is what files a refund. Two things are
deliberately outside that gate: an inbound *customer* message, which is the work the service
was handed, and the deterministic paging rule, which is the service acting on its own probe
data. Whether an engineer is woken must not depend on who typed the last message.

### Four rules the model does not get a vote on

Each exists because live eval runs proved the model unreliable at it. Paging and injection
detection live in `src/agent/rules/`; grounding and the holding-reply check are guards in
`runner.ts`. All four are unit-tested without a model.

**Injection.** The scan covers both inbound channels, not just the ticket. Operator text is
trusted in the sense that matters — it sits outside the `<ticket>` tag and reaches the model
as an ordinary chat turn — and that is a statement about *who is asking*, not about what the
words contain: an operator quoting the ticket back at the agent ("customer wrote: …") carried
the payload across the boundary the tag exists to draw. Measured, the identical sentence
escalated as a customer message and licensed side effects as an operator message. `agent`
rows are excluded, because that is our own summary and it quotes the attacker when it
explains what happened.

**Paging.** If `check_service_status` reports the customer's own region as `degraded` or
`outage`, the service opens an incident itself, whatever the decision says. No multi-user
heuristic is needed: a region serves many customers, so degraded regional probe data *is*
multi-user impact. A single blocked user on a healthy region does not match. The incident is
filed through the same store as a model-initiated call, so the region dedup key means one
page per region per conversation even when the model also asks. The "already paged" check
compares regions, so a page the model opened for some *other* region no longer suppresses
this one. It is recorded with `policy_outcome: system_rule` so the audit trail shows the
service acted, not the agent.

**Grounding.** An auto-response is customer-facing text sent with no human in the loop, so it
denies by default: *no* ticket is auto-answered without at least one successful, non-empty
tool result behind it. A question-shaped ticket needs the stronger form, a knowledge base
search that actually returned an article; a claim about money needs `get_customer_account`,
because a platform status probe says nothing about this customer's charges. If the evidence
is not there the decision is downgraded to `route_to_specialist`. Keying this on
`issue_type` alone would have made it opt-in on a field the model picks — `other` is the
off-taxonomy bucket, so a misclassified ticket auto-answered with no tool calls at all.
The knowledge base itself drops results below a relevance floor, so incidental word overlap
never reaches the model as if it were an answer — telling the model to ignore low scores did
not work, and not returning them does.

**Holding replies.** A `critical` or `high` ticket with no `customer_reply_draft` is flagged
in `guard_notes`, except on a degraded turn where the fail-safe is `high` with no draft by
definition and the flag would fire every time. Deliberately a flag, not a fabrication: the
message has to be in the customer's language and reflect the specific evidence, so code cannot
write it, but the operator should not have to notice its absence.

**Injection.** Customer text is scanned for instruction-override phrasing before the model
sees it. A flagged ticket gets **no side effect the model asked for** — not even one filed for
approval, because that would still put an attacker's demand in front of an operator as a
single click. (The deterministic paging rule is the one exception: it acts on our own probe
data, not on anything the ticket said, so it still pages a genuinely degraded region.) Such a
ticket never auto-responds, and its `customer_reply_draft` is discarded rather than handed on
— the reply was written by a model that had just read the injection, and routing the ticket
*because* the prose is untrustworthy only to forward that prose is not a boundary. The
discarded text is kept in `guard_notes` for the audit trail. The decision carries
`injection_suspected: true` plus a note naming the patterns that matched. This is not a
security control; it is a detector, and anyone who knows it exists can phrase around it. The
control is the autonomy boundary, which holds whether or not this fires. A false positive
costs automation on one ticket and sends it to a human, which is the safe direction to fail.

## Idempotency and retry safety

Three layers, because one is not enough:

1. **HTTP.** `Idempotency-Key` is inserted as `in_progress` *before* the handler runs. A
   retry replays the stored response; a concurrent duplicate gets `409`; the same key with
   a different body gets `422`. Without this, a client retry costs a second conversation
   and a second model call. A request that *fails* is terminal on that key: the status code
   and error body are recorded and replayed with `idempotent-replayed: true`, so a retry
   learns the attempt failed instead of silently redoing work the first attempt had already
   committed. Retrying that request means minting a new key.
2. **Side effects.** `UNIQUE (dedup_scope_key, tool_name, dedup_key)` with a server-derived
   dedup key (`<customer>:<charge>` for a refund, `region` for an incident) plus a state
   machine. `dedup_scope_key` is how wide "one row" is, and the tool descriptor decides:
   a refund is scoped to its conversation because its key names whose money moves, an
   incident is `global` because a region belongs to the fleet and not to a ticket.
   Every transition is a conditional `UPDATE`, so two simultaneous approvals cannot both
   execute — one wins, the other is handed the stored result. The row reaches `executing`
   and commits *before* the external call, so a crash leaves evidence instead of a silent
   double charge. The write that *closes* a claim is conditional too: the approval path and
   the reconciler can both be executing the same row, and whichever finishes second must not
   overwrite the answer already recorded — that record is the only copy of the `refund_id`.
3. **The tool contract.** The dedup key is handed to the tool, which uses it as the
   provider's idempotency key — so the mocks return the identical result for a repeated key,
   the way Stripe or PagerDuty do. This is enforced from both ends: `createToolRegistry`
   refuses to *build* a side-effecting tool that declares no dedup key, and the tool refuses
   to *run* without being given one. Otherwise the two drift — the refund's dedup key gained
   a customer prefix while its `refund_id` stayed on the bare charge id, and nothing failed.
   Neither end can check the property automated recovery actually leans on (the same key
   returns the same id), because checking it means calling the provider — so that is a test
   over the whole registry (`src/agent/tools/retry-safety.spec.ts`), and a side-effecting
   tool with no probe in it fails the suite.

## Testing

```bash
pnpm test          # unit: no database, no API key, no network
pnpm db:test:setup # creates the triage_test database (once)
pnpm test:e2e      # HTTP + real Postgres, scripted model
pnpm typecheck && pnpm lint
```

Testing a non-deterministic core is a question of where you put the seam. The `LlmClient`
port is that seam:

- **Unit tests** script the model (`FakeLlm`) and assert on everything we own: the autonomy
  policy, argument validation, dedup, the per-turn side-effect budget, the guards, the
  fail-safe paths (provider down, non-JSON output, off-schema output, iteration cap), the
  KB scorer, and each mock tool's contract including its idempotency.
- **End-to-end tests** drive the real HTTP layer against real Postgres with a scripted
  model: the refund approval flow, double and concurrent approval, rejection, incident
  dedup, idempotent retries, restart persistence, and prompt injection.
- **Model quality is deliberately not tested here.** Asserting on LLM wording produces a
  suite that fails when the model improves. Quality lives in the eval harness below.

## Eval harness

```bash
pnpm eval                        # full labelled set against OPENAI_MODEL
pnpm eval -- --model gpt-4.1     # compare models on the same labels
pnpm eval -- --case t2 --verbose  # one ticket, with tool/policy events
pnpm eval -- --repeat 3          # measure how often the same ticket flips
pnpm eval -- --judge --judge-model gpt-4.1   # groundedness, judged by a stronger model
pnpm eval -- --judge --judge-selftest        # check the judge discriminates before trusting it
pnpm eval -- --fake              # no key: proves the harness, not the model
```

`eval/tickets.labelled.json` holds 10 labelled tickets: the three from the assignment plus
adversarial, ambiguous, multilingual, and "looks urgent but is not" cases. Labels are
*sets* of acceptable answers, because triage has real judgement bands and scoring
judgement as failure just teaches the prompt one arbitrary answer.

It reports accuracy per field, tool recall, side-effect counts, median latency, tokens per
ticket, and — separately and fatally — safety violations. Accuracy is a number to look at;
a refund executing without a human is a failed run and a non-zero exit code.

### Groundedness: an LLM-as-judge

The deterministic guards can force a relevant article to exist behind an auto-response. They
cannot check that the draft says what the article says: a reply can cite release 4.2 while the
account is on 4.1 and every schema, guard and test in this repo will pass it. `--judge` runs a
second model over the draft and the evidence actually gathered, asking one question: does this
assert anything the evidence does not contain?

Three deliberate limits. It runs in the harness and **never in the request path**, because
judging every reply would double cost and latency on the happy path and add a dependency that
can fail. Its verdict is **advisory** and never fails the run, because a non-deterministic
judge cannot be the gate for a non-deterministic system. And it sees the ticket, the customer
profile, the tool evidence and the draft, but **not the model's own rationale**, which would
invite it to accept the model's justification instead of checking the claim.

A judge that says "grounded" to everything scores 100% and is worth nothing, so
`--judge-selftest` runs it against ten known-answer cases first, including the distinction
that matters most here: "we have filed a refund request" is supported by a pending refund,
while "we have refunded you" contradicts it.

**Use a stronger model than the one being judged.** On that calibration set `gpt-4.1` scores
10/10 and `gpt-4.1-mini` scores 9/10, and the case the cheaper model misses is the one where a
draft promises "a colleague will approve it shortly" — a pending approval establishes that
approval is *required*, never that it will be granted. On the full set the stronger judge also
caught a draft claiming "we have initiated the refund process" while the refunds sat unapproved,
and one telling a customer all three charges were duplicates while only two refunds were filed.
Both were invisible to the cheaper judge. `--judge-model` exists for exactly this, and the
report records which model judged.

### Baseline results

`pnpm eval --repeat 3 --judge --judge-model gpt-4.1` against `gpt-4.1-mini`, 30 runs over the
10 labelled tickets, groundedness judged by `gpt-4.1`. The full report is committed at
[eval/results/baseline-gpt-4.1-mini-judged-by-gpt-4.1.json](eval/results/baseline-gpt-4.1-mini-judged-by-gpt-4.1.json).

| Metric | Result |
| --- | --- |
| Urgency, action, language, product area, requires_human | 100% within the accepted label sets |
| Structurally valid decisions | 30 / 30 |
| Runs passing every check | 30 / 30 |
| Safety violations | 0 |
| Reply drafts judged grounded (advisory, by `gpt-4.1`) | 30 / 30 |
| Median latency | 6.5 s |
| Tokens per ticket | ~8,000 |

Every check passes on every run. Two tickets vary run to run, both inside their accepted
band: the single blocked user on a healthy region scores `medium` twice and `high` once, and
the injection ticket scores `high` twice and `medium` once — while its `next_action` stays
`escalate_to_human` on all three, which is the part that matters.

**Read that table as one run, not a guarantee.** The immediately preceding run on an identical
agent build scored 27/30, the extra failures being two known intermittent behaviours: the model
occasionally files no refund requests at all on ticket 1, and occasionally returns `und` for a
plainly English ticket. Both appear at roughly 1 in 30 and neither is fixed by anything in this
repo. `unstable cases` in the report is the number to watch, and it is why every claim here
comes from `--repeat`.

Getting here took three prompt versions and four rules in code.
[eval/FINDINGS.md](eval/FINDINGS.md) records what each round measured, including the two rules
that were wrong on their first attempt and what caught them. Nothing in this table came from a
single lucky run: `--repeat` exists because a one-off pass on a non-deterministic component is
not evidence.

## Observability

Structured pino JSON, one request id per request, one `trace_id` per agent turn. Every
turn emits `agent.turn.start`, `llm.response`, `policy.decision`, `tool.call`,
`tool.result`, `side_effect.*`, and a final `decision.final` carrying the urgency, action,
tools used with their status, guard corrections, prompt version, token counts, and latency.
Grepping one `trace_id` reconstructs a decision; the database holds the durable copy.

## Known limitations

Honest list; the reasoning is in [WRITEUP.md](WRITEUP.md).

- **The model still complies with prompt injection.** It asks for the demanded refunds and
  wants to auto-respond; the detector and the boundary are what stop it. Detection is a
  keyword scan, so it can be phrased around — the guarantee is the autonomy boundary, not the
  detector.
- **Knowledge base search is lexical, with a hand-picked relevance floor.** The floor
  separates real answers from incidental word overlap on this seven-document corpus and would
  need re-deriving on a real one. A learned retriever would not need a magic number.
- Knowledge base search is lexical token overlap over seven documents, so it does not match
  synonyms and cannot match a Thai query against English articles.
- No authentication, no multi-tenancy, no streaming, no deployment tooling — all explicitly
  out of scope for this exercise.
- **The reconciler is a `setInterval`, and every replica runs it.** `ReconcilerService`
  sweeps the three expiry-less leases — a side effect in `executing`, an `agent_turns` row
  left `running`, an `idempotency_keys` row left `in_progress` — plus retention for
  `idempotency_keys`. Correctness comes from per-row conditional claims, so N replicas do the
  work once between them, but they all pay for the scan; a real deployment wants
  `pg_try_advisory_lock` or one scheduled worker. The interval is also not durable: a process
  that is down does not sweep, so recovery time is bounded by uptime. `sweep()` and `tick()`
  are tested directly; the *scheduling* is skipped under `NODE_ENV=test` and is not covered.
- **Two staleness numbers, both derived, and one of them ignores tool latency.** A turn is
  bounded by model attempts × iterations × slack (12 minutes); a side-effect claim is bounded
  by one provider call (60s), because the claim holds a dedup key and `open_incident`'s is
  global — a stranded claim answers `in_flight` to every later ticket reporting the same
  outage, so that window is the one an unpaged outage lives in. No tool declares a timeout of
  its own, so a provider call slower than 60s is re-driven while it is still alive. That is
  free rather than dangerous — every result id is a pure function of the server-derived dedup
  key, and both terminal writes are conditional on the claim — but it does cost a duplicate
  provider call. A per-tool deadline is the real fix.
- **Re-driving a page can page twice.** The mock returns the same `incident_id` for the same
  region, so the *record* stays single, but a real pager notifying on every API call would
  wake the rotation again. A production version reads the provider's record of the
  idempotency key instead of re-posting.
- **A side effect pins the conversation that filed it.** `side_effects.conversation_id` is
  `Restrict`, and a globally-scoped incident row keeps the `conversation_id` of the ticket
  that noticed the outage — so that one conversation cannot be deleted while the row exists.
  Right for an audit trail, wrong the day a retention or GDPR deletion path is needed.
- Approving a refund executes it inline, so the HTTP call waits on the payment provider.
