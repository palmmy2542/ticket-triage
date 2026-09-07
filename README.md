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

## Setup

Requires Node >= 22, pnpm, and Docker.

```bash
cp .env.example .env      # then paste your OPENAI_API_KEY into .env
docker compose up -d db && pnpm install && pnpm setup && pnpm start:dev
```

`pnpm setup` applies the Prisma migration. The service listens on `http://localhost:3000`.

If host port 5433 is already taken, set `DB_PORT` to a free port in `.env` and update the
port in `DATABASE_URL` to match. Without Docker, point `DATABASE_URL` at any Postgres 14+
and run `pnpm setup`.

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

# Ask the agent a follow-up question as an operator
curl -s -X POST localhost:3000/conversations/$CONV/messages \
  -H 'content-type: application/json' \
  -d '{ "role": "operator", "content": "Which charges did you verify, and why not refund all three?" }'

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
   ├─ prompt/system.v1.md                        versioned, commented, comments stripped
   ├─ schema.ts                                  the decision contract (zod, strict)
   ├─ tools/                                     descriptor = schema + autonomy + dedup + impl
   ├─ policy.ts                                  pure autonomy decision
   ├─ runner.ts                                  the loop, guards, fail-safe
   └─ llm.ts (port) → OpenAiLlm | FakeLlm | CannedLlm
   ↓
Postgres (Prisma)                 prisma/        conversations, messages, agent_turns,
                                                 tool_calls, side_effects, idempotency_keys
```

The agent core imports nothing from the framework or the database: it receives an
`LlmClient`, a `SideEffectStore`, and a `Logger` as parameters. That is what makes the
tests deterministic and the core reusable from a queue worker or a CLI.

**Adding a tool** is one file plus one line in `tools/registry.ts`. Autonomy and the dedup
rule live on the descriptor, so a side-effecting tool cannot be registered without
declaring how retries are deduplicated — `createToolRegistry` throws otherwise.

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
actually executed — so the model cannot claim a refund it did not get.

## Idempotency and retry safety

Three layers, because one is not enough:

1. **HTTP.** `Idempotency-Key` is inserted as `in_progress` *before* the handler runs. A
   retry replays the stored response; a concurrent duplicate gets `409`; the same key with
   a different body gets `422`. Without this, a client retry costs a second conversation
   and a second model call.
2. **Side effects.** `UNIQUE (conversation_id, tool_name, dedup_key)` with a server-derived
   dedup key (`charge_id` for a refund, `region` for an incident) plus a state machine.
   Every transition is a conditional `UPDATE`, so two simultaneous approvals cannot both
   execute — one wins, the other is handed the stored result. The row reaches `executing`
   and commits *before* the external call, so a crash leaves evidence instead of a silent
   double charge.
3. **The tool contract.** The mocks derive their result id from the dedup key and return
   the identical result for a repeated key, the way Stripe or PagerDuty do.

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
pnpm eval -- --fake              # no key: proves the harness, not the model
```

`eval/tickets.labelled.json` holds 10 labelled tickets: the three from the assignment plus
adversarial, ambiguous, multilingual, and "looks urgent but is not" cases. Labels are
*sets* of acceptable answers, because triage has real judgement bands and scoring
judgement as failure just teaches the prompt one arbitrary answer.

It reports accuracy per field, tool recall, side-effect counts, median latency, tokens per
ticket, and — separately and fatally — safety violations. Accuracy is a number to look at;
a refund executing without a human is a failed run and a non-zero exit code. Reports are
written to `eval/results/` (gitignored: they need a key to produce).

## Observability

Structured pino JSON, one request id per request, one `trace_id` per agent turn. Every
turn emits `agent.turn.start`, `llm.response`, `policy.decision`, `tool.call`,
`tool.result`, `side_effect.*`, and a final `decision.final` carrying the urgency, action,
tools used with their status, guard corrections, prompt version, token counts, and latency.
Grepping one `trace_id` reconstructs a decision; the database holds the durable copy.

## Known limitations

Honest list; the reasoning is in [WRITEUP.md](WRITEUP.md).

- **Not verified against a live model.** Everything here runs against a scripted or canned
  model. The prompt has not been iterated against real `gpt-4.1-mini` output and the eval
  set has never been run with a key, so no accuracy number is claimed.
- Knowledge base search is lexical token overlap over seven documents, so it does not match
  synonyms and cannot match a Thai query against English articles.
- No authentication, no multi-tenancy, no streaming, no deployment tooling — all explicitly
  out of scope for this exercise.
- A side effect stuck in `executing` (process killed mid-call) is visible but is not
  reconciled automatically; a real deployment needs a sweeper.
- Approving a refund executes it inline, so the HTTP call waits on the payment provider.
