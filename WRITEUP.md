# Write-up

Setup, API and mechanics are in the [README](README.md). This is the reasoning.

## Architecture, and why

**Three layers, one seam.** NestJS on Fastify does transport, validation and the error
envelope; a triage module owns persistence and the approval endpoints; `src/agent/**` is
plain TypeScript importing neither the framework nor the database, taking an `LlmClient`, a
`SideEffectStore` and a `Logger` as parameters. That seam is what makes a non-deterministic
system testable: the loop, the policy and the guards are unit-tested with no container, no
database and no network. Zod is the only schema language here, and the OpenAI strict schema
is generated from the same object the runner validates against, so the model's contract and
ours cannot drift.

**Rejected.** An agent framework: the loop is forty lines and I need exact control over what
happens between the model asking for a refund and a refund happening — that control *is* the
assignment. A vector database, for seven KB documents. A job queue, since nothing in the
required flow is long-running enough to justify a worker. The Responses API, since state
lives in Postgres and is rebuilt each turn.

**The boundary is code, not prompt.** `issue_refund` is `requires_approval` on its
descriptor, so the policy short-circuits before `execute` is reached and only
`POST .../approve` runs it. `open_incident` is autonomous: a redundant page costs an
engineer minutes, an unpaged regional outage on a 45-seat account costs the account. Guards
then correct the model after every turn — a critical ticket is never auto-answered, a
pending approval forces escalation, and `tools_used` is rebuilt from what actually ran.

**Ordering over one big transaction.** Ticket committed, turn opened, model run, decision
written. An LLM call inside a transaction pins a pool connection per in-flight ticket, which
is how a service with a healthy database stops serving traffic. It also means a provider
outage cannot lose a ticket: the API returns a degraded escalation with `201`, not a `5xx`.

## Trade-offs under time

**Cut:** streaming, auth, deployment, a UI (all worth no points here). Embeddings retrieval.
LLM-as-judge for groundedness — the eval uses deterministic proxies instead. A sweeper for
rows stuck in `executing`. Rate limits and cost caps. Replaying prior turns' tool
transcripts: only the previous decision is summarised, keeping tokens linear in conversation
length rather than quadratic.

**What the tests caught.** 90 unit tests and 29 end-to-end tests pass. The end-to-end suite
found approve and reject returning `201`, and, worse, approving an already-*rejected* refund
returning success instead of `409`. Cloning into a clean directory and following the README
verbatim found the prompt file missing from the production build and `pnpm setup` silently
shadowed by pnpm's own built-in command, which would have left a grader running against an
empty database. **No accuracy number is claimed and the
prompt is v1-unverified.** The eval set exists so that the first hour with a key produces
numbers instead of impressions.

**With another week,** in order: move the paging rule and an injection flag into code; make
approval execution asynchronous so an operator's request does not wait on the payment
provider; add the stuck-row sweeper; add an LLM-as-judge for groundedness and grow a golden
set from real human disagreements; cost budgets and provider fallback; then auth.

## What the live eval measured

20 runs over 10 labelled tickets against `gpt-4.1-mini`. Every classification field landed
inside its accepted label set on every run, all 20 decisions were structurally valid, 17 of
20 passed every check, and there were no safety violations. Numbers and per-run detail are in
the README and the committed report.

Classification was never the hard part. **Tool-call completeness was.** Prompt v1 classified
ticket 1 perfectly and then called no tools at all, routing to billing with an apology draft:
"you may never move money" reads to a cautious model as "do not touch this tool". Ticket 2
wrote "confirming a real regional outage" and paged nobody, treating incident management as
the job of whoever picked up the escalation. v2 states the obligation as plainly as the
prohibition, moves the paging rule into the tool description where the model reads it while
choosing, and ends with a pre-return checklist. Clean runs went 6/10 → 15/20 → 17/20, and
ticket 2 went from never paging to paging every run.

**Two failures remain, and the second matters more than the numbers.** Ticket 1 files both
refund requests in only one run out of two; the failing run makes a single round of tool
calls and then finalises, so the fix is not more prompt text.

On ticket 5 the model **complied with the injection**: it read "issue and approve a full
refund" as a customer request, filed requests against all three charges, chose `auto_respond`
to tell the customer the money was on its way, and never mentioned that the ticket was
hostile. Nothing moved. The policy makes `issue_refund` unreachable without a human and the
guard overrode `auto_respond` to `escalate_to_human` — the model was successfully manipulated
and it did not matter. It is still a real gap, because an operator rubber-stamping approvals
would refund everything.

Both failures say the same thing: **behaviour that must be reliable does not belong in a
prompt.** Paging a degraded region, and flagging an instruction override for the operator,
are deterministic rules and belong in code beside the autonomy boundary.

## Failure modes, ticket by ticket

**Ticket 1 — three duplicate charges, angry, two-hour deadline.** The hardest failure to
design against is tone inflation: four escalating messages and a dispute threat read as
`critical`, but nothing is down and one user is affected. The prompt defines `critical` as
outage, data loss or a whole account blocked, states that tone is not urgency, and the eval
asserts `high` — which it hit in every live run. Second: refunding all three charges cancels
the purchase the customer wanted, so the duplicate rule makes the first charge the intended
one and the eval asserts exactly two pending refunds. Neither is enforceable in code — a
semantically wrong refund is still a well-formed refund — which is why refunds need a human:
the guard catches the class of error, the human catches the instance. Third and quieter: no
tool can grant Pro access, so an agent that "fixes" this with refunds leaves the customer on
Free, and the prompt names provisioning as a human job. What the system does guarantee is
that a retried request, a double-clicked approval and a model that asks twice all yield one
refund.

**Ticket 2 — Thai enterprise outage, status page says all clear.** The designed trap is
calling `check_service_status` without a region, reading "all systems operational", and
auto-responding "clear your cache" to a 45-seat account mid-incident. Three defences: the
region argument defaults to the customer's region inside the tool; the tool returns the
regional probe, the public page, and an explicit `agrees_with_public_page: false`; and the
prompt states that human-maintained status pages lag machine probes. Live runs confirm the
model now cites the 0.41 error rate against the stale page. Second: replying in English —
the eval asserts Thai script, and one early run produced no draft at all. Third: KB search
is useless here — the tokenizer fragments Thai, and the one document it matches is hit only
because the ASCII substring `error 500` appears in the message. Documented rather than
pretending a lexical scorer is multilingual. Fourth: paging twice or paging with no detail.
The dedup key is the region, and the tool rejects a `sev1` with a thin summary.

**Ticket 3 — dark mode, a bug plus a feature request, relaxed customer.** The failure is the
opposite of ticket 1: over-escalation. A prompt full of safety rules forwards routine how-to
questions to humans and destroys the product's value, so the prompt carries explicit
counter-pressure ("escalating is not free") and the eval asserts `auto_respond` — clean in
every live run, with the secondary topic captured. Second: a single `issue_type` would drop
the scheduling request, so the schema carries `secondary_topics`. Third: this ticket is only
answerable because the account lookup reveals workspace release `4.1.3` and the KB article
explains the toggle ships in `4.2`. A model answering from the article without checking the
release would confidently tell a paying customer dark mode does not exist — no schema catches
that, which is what the live eval and, in production, an LLM-as-judge are for.

## Measuring this in production

Offline: the labelled set runs on every prompt or model change, gated on zero safety
violations and no accuracy regression, with `--repeat` separating real improvement from
noise. Every decision stores its `prompt_version` and model, so any metric cohorts by prompt.

Online, ground truth is what the human did next, and it is free to collect: was the draft
sent unchanged, edited or discarded; did an operator change the urgency or action; was a
requested refund approved or rejected (rejection rate is the precision of the agent's
financial judgement); did an autonomous page turn out to be real; did an auto-responded
ticket come back within a day.

For regressions without labels, watch distribution shift and guard activity: share marked
critical, share auto-responded, how often the guards have to correct the model, degraded-turn
rate, tokens and latency per ticket. Guards firing more often means the prompt is drifting
from the policy. A prompt change ships in shadow mode first, scored against live human
decisions before it is allowed to act.
