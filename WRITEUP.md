# Write-up

Setup, API and mechanics are in the [README](README.md). This is the reasoning.

## Architecture, and why

**Three layers, one seam.** NestJS on Fastify does transport, validation and the error
envelope; a triage module owns persistence and the approval endpoints; `src/agent/**` is
plain TypeScript that imports neither the framework nor the database. The core takes an
`LlmClient`, a `SideEffectStore` and a `Logger` as parameters. That one seam is what makes
a non-deterministic system testable: the loop, the policy and the guards are all unit-
tested with no container, no database and no network.

**Chosen deliberately.** NestJS + Fastify + Postgres + Prisma is what I run in production,
so I can defend every layer, and Nest modules give the agent/transport/persistence split
for free. Zod is the only schema language in the repo — request bodies, tool arguments, the
decision, the environment — and the OpenAI strict JSON schema is generated from the same
object the runner validates against, so the model's contract and ours cannot drift.

**Rejected.** An agent framework: the loop is forty lines, and I need exact control over
what happens between the model asking for a refund and a refund happening — that control
*is* the assignment. A vector database: seven KB documents, so lexical scoring wins on
every axis. A job queue: nothing in the required flow is long-running enough to justify a
worker and its failure modes. Chat Completions over the Responses API: conversation state
lives in Postgres and is rebuilt each turn, so provider-side state buys nothing.

**The boundary is code, not prompt.** `issue_refund` is declared `requires_approval` on its
descriptor and the policy short-circuits before `execute` is reached; only
`POST .../approve` runs it. `open_incident` is autonomous, because a redundant page costs
an engineer minutes while an unpaged regional outage on a 45-seat enterprise account costs
the account. The prompt asks the model to cooperate; the code makes cooperation optional.
Guards then correct the model after every turn — a critical ticket is never auto-answered,
a pending approval forces escalation, and `tools_used` is rebuilt from what actually ran,
so the model cannot report a refund it never got.

**Ordering over one big transaction.** Ticket committed, turn row opened, model run,
decision written. A multi-second LLM call inside a transaction pins a pool connection per
in-flight ticket, which is how a service with a healthy database stops serving traffic. It
also means a provider outage cannot lose a ticket: the conversation is already durable, so
the API returns a degraded escalation with `201` rather than a `5xx`. Losing a support
ticket is worse than returning a low-confidence one.

## Trade-offs under time

**Cut:** streaming, auth, deployment, a UI (all worth no points here). Embeddings
retrieval. LLM-as-judge for draft groundedness — the eval uses deterministic proxies
instead. A sweeper for rows stuck in `executing`. Rate limits and per-conversation cost
caps. Replaying prior turns' tool transcripts: only the previous decision is summarised,
keeping tokens linear rather than quadratic in conversation length.

**The honest gap: no live model run.** No API key was available. The prompt has never been
iterated against real `gpt-4.1-mini` output and the labelled set has never been run with a
key. Everything here is verified against a scripted or canned model: 90 unit tests and 29
end-to-end tests pass, the eval harness smoke-tests with `--fake` (where it correctly fails
accuracy while safety and structure hold), and the documented setup path was checked by
cloning into a clean directory and following the README verbatim. That last step is worth
the ten minutes: it found the prompt file missing from the production build and `pnpm setup`
being silently shadowed by pnpm's own built-in command, so a grader would have got a
service running against an empty database. The end-to-end suite paid for itself too — it
caught approve and reject returning `201`, and, more seriously, approving an
already-rejected refund returning success instead of `409`. **No accuracy number is claimed and the
prompt is v1-unverified.** The eval set exists so that the first hour with a key produces
numbers instead of impressions.

**With another week,** in order: run the eval and iterate the prompt; add the stuck-row
sweeper and make approval execution asynchronous so an operator's request does not wait on
the payment provider; add an LLM-as-judge for groundedness and grow a golden set from real
human disagreements; cost budgets and provider fallback; OpenTelemetry spans; then auth.

## Failure modes, ticket by ticket

**Ticket 1 — three duplicate charges, angry, two-hour deadline.** The hardest failure to
design against is tone inflation: four escalating messages and a dispute threat read as
`critical`, but nothing is down and one user is affected. The prompt defines `critical` as
outage, data loss or a whole account blocked, states that tone is not urgency, and the eval
asserts `high`. Second failure: refunding all three charges, which cancels the purchase the
customer wanted. The prompt's duplicate rule makes the first charge the intended one and
the eval asserts exactly two pending refunds. Neither is enforceable in code — a
semantically wrong refund is still a well-formed refund — which is exactly why refunds need
a human: the guard catches the class of error, the human catches the instance. Third and
quieter: no tool can grant Pro access, so an agent that "fixes" this with refunds leaves
the customer on Free; the prompt names provisioning as a human job. What the system does
guarantee is that a retried request, a double-clicked approval and a model that asks twice
all yield one refund.

**Ticket 2 — Thai enterprise outage, status page says all clear.** The designed trap is
calling `check_service_status` without a region, reading "all systems operational", and
auto-responding "clear your cache" to a 45-seat account during a live incident. Three
defences: the region argument defaults to the customer's region inside the tool; the tool
returns the regional probe, the public page, and an explicit `agrees_with_public_page:
false`; and the prompt states that human-maintained status pages lag machine probes.
Second: replying in English — the eval asserts Thai script in the draft. Third: KB search
is useless here. The tokenizer fragments Thai, and the one document it matches is hit only
because the ASCII substring `error 500` appears in the message. I left that documented
rather than pretend a lexical scorer is multilingual; a real deployment needs a
multilingual retriever. Fourth: paging twice, or paging with no detail. The incident dedup
key is the region, so one page per region per conversation, and the tool rejects a `sev1`
with a thin summary.

**Ticket 3 — dark mode, a bug plus a feature request, relaxed customer.** The failure is
the opposite of ticket 1: over-escalation. A prompt full of safety rules forwards routine
how-to questions to humans and destroys the product's value, so the prompt carries explicit
counter-pressure ("escalating is not free") and the eval asserts `auto_respond`. Second: a
single `issue_type` silently drops the scheduling request, so the schema carries
`secondary_topics` and the prompt requires the draft to address every issue raised. Third:
this ticket is only answerable because the account lookup reveals workspace release `4.1.3`
and the KB article explains the toggle ships in `4.2` and that "System Default" is broken on
macOS before it. A model that answers from the article without checking the release will
confidently tell a paying customer dark mode does not exist. No schema catches that; it
needs the live eval, and in production an LLM-as-judge on draft-versus-evidence.

## Measuring this in production

Offline: the labelled set runs on every prompt or model change, gated on zero safety
violations and no regression in urgency and action accuracy, with `--repeat` separating
real improvement from run-to-run noise. Every decision stores its `prompt_version` and
model, so any metric cohorts by prompt.

Online, ground truth is what the human did next, and it is free to collect: was the draft
sent unchanged, edited or discarded; did an operator change the urgency or action; was a
requested refund approved or rejected (rejection rate is the precision of the agent's
financial judgement); did an autonomous page turn out to be a real incident; did an
auto-responded ticket come back within a day. Those five cover the decisions that cost
money and trust.

For regressions without labels, watch distribution shift and guard activity: share of
tickets marked critical, share auto-responded, how often the deterministic guards have to
correct the model, degraded-turn rate, and tokens and latency per ticket. Guards firing
more often means the prompt is drifting from the policy. A prompt change ships in shadow
mode first, scored against live human decisions before it is allowed to act.
