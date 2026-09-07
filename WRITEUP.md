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
assignment. A vector database, for seven documents. A job queue, since nothing here is
long-running enough to justify a worker. The Responses API, since state lives in Postgres.

**The boundary is code, not prompt.** `issue_refund` is `requires_approval` on its
descriptor, so the policy short-circuits before `execute` is reached and only
`POST .../approve` runs it. `open_incident` is autonomous: a redundant page costs an engineer
minutes, an unpaged regional outage on a 45-seat account costs the account. Guards then
correct the model every turn — a critical ticket is never auto-answered, a pending approval
forces escalation, `tools_used` is rebuilt from what actually ran — and two behaviours it
proved unreliable at are rules in code rather than requests in prose.

**Ordering over one big transaction.** Ticket committed, turn opened, model run, decision
written. An LLM call inside a transaction pins a pool connection per in-flight ticket, which
is how a service with a healthy database stops serving traffic — and it means a provider
outage cannot lose a ticket, since the API returns a degraded escalation rather than a 5xx.

## Trade-offs under time

**Cut:** streaming, auth, deployment, a UI (all worth no points here). Embeddings retrieval.
LLM-as-judge for groundedness. A sweeper for rows stuck in `executing`. Rate limits and cost
caps. Replaying prior turns' tool transcripts: only the previous decision is summarised, so
tokens grow linearly rather than quadratically.

**What the tests caught.** 133 unit tests and 29 end-to-end tests pass. The end-to-end suite
found approving an already-*rejected* refund returning success instead of `409`. Following
the README verbatim in a clean clone found the prompt file missing from the production build
and `pnpm setup` silently shadowed by pnpm's own built-in command, which would have left a
grader running against an empty database. **No accuracy number is claimed and the
prompt is v1-unverified.** The eval set exists so that the first hour with a key produces
numbers instead of impressions.

**With another week,** in order: make approval execution asynchronous so an operator's
request does not wait on the payment provider; add the stuck-row sweeper; replace the
keyword injection detector with a classifier and grow the pattern set from real traffic; add
an LLM-as-judge for groundedness and a golden set built from real human disagreements; cost
budgets and provider fallback; then auth.

## What the live eval measured

20 runs over 10 labelled tickets against `gpt-4.1-mini`, `--repeat 2`. Every check passes on
every run: classification 100% within its accepted label sets, 20/20 structurally valid, zero
safety violations, ~7 s and ~7.9k tokens per ticket. The only variation left is one ticket
scoring `high` on one run and `medium` on the next, both inside the accepted band.

Classification was never the hard part. **Tool-call completeness was**, and it took three
prompt versions and four rules in code to get from 6/10 clean runs to 20/20. The blow-by-blow
is in [eval/FINDINGS.md](eval/FINDINGS.md); the lesson is one sentence: **behaviour that must
be reliable does not belong in a prompt.** Prompt v1 triaged ticket 1 perfectly and then
called no tools at all, because "you may never move money" reads to a cautious model as "do
not touch this tool". Ticket 2 wrote "confirming a real regional outage" and paged nobody in a
third of runs. And on ticket 5 the model **complied with the injection**, filing refunds
against all three charges and choosing `auto_respond` to tell the customer the money was on
its way — nothing moved, because `issue_refund` is unreachable without a human and the guard
rewrote the action, but an operator rubber-stamping approvals would have refunded everything.

So paging, injection flagging, answer grounding, and the holding-reply check became rules in
code, and two of those rules were wrong on their first attempt. Both mistakes were caught by
re-running the harness rather than by reasoning, which is the whole case for keeping it cheap
to run.

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
prompt states that human-maintained status pages lag machine probes. Live runs now cite the
0.41 error rate against the stale page. Second: replying in English, or not at all — the eval
asserts Thai script and a holding reply. Third: KB search is useless here, because the
tokenizer fragments Thai and the one document it matches is hit only via the ASCII substring
`error 500`. Documented rather than pretending a lexical scorer is multilingual.

**Ticket 3 — dark mode, a bug plus a feature request, relaxed customer.** The failure is the
opposite of ticket 1: over-escalation. A prompt full of safety rules forwards routine how-to
questions to humans and destroys the product's value, so the prompt carries explicit
counter-pressure ("escalating is not free") and the eval asserts `auto_respond` — clean in
every live run, secondary topic captured. Second: a single `issue_type` would drop the
scheduling request, so the schema carries `secondary_topics`. Third: this ticket is only
answerable because the account lookup reveals release `4.1.3` while the KB article explains
the toggle ships in `4.2`. A model answering from the article without checking the release
would confidently tell a paying customer dark mode does not exist — the grounding guard
forces a relevant article to exist, but not that it was read correctly, which is what an
LLM-as-judge would be for.

## Measuring this in production

Offline: the labelled set runs on every prompt or model change, gated on zero safety
violations and no accuracy regression, with `--repeat` separating improvement from noise.
Every decision stores its `prompt_version` and model, so any metric cohorts by prompt — which
is how the severity-anchoring regression above was attributable at all.

Online, ground truth is what the human did next, and it is free to collect: was the draft
sent unchanged, edited or discarded; did an operator change the urgency or action; was a
requested refund approved or rejected (rejection rate is the precision of the agent's
financial judgement); did an autonomous page turn out to be real; did an auto-responded
ticket come back within a day.

Without labels, watch distribution shift and guard activity: share marked critical, share
auto-responded, how often guards correct the model, how often the paging and injection rules
fire, degraded-turn rate, tokens and latency. Guards firing more often means the prompt is
drifting from the policy. A prompt change ships in shadow mode first, scored against live
human decisions before it is allowed to act.
