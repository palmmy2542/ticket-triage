# Write-up

Setup, API and mechanics are in the [README](README.md); the measured numbers are its
[baseline results](README.md#baseline-results) and the round-by-round detail is
[eval/FINDINGS.md](eval/FINDINGS.md). This is the reasoning.

## Architecture, and why

**Three layers, one seam.** NestJS on Fastify does transport, validation and the error
envelope; a triage module owns persistence and the approval endpoints; `src/agent/**` is plain
TypeScript importing neither the framework nor the database, taking an `LlmClient`, a
`SideEffectStore` and a `Logger` as parameters. That seam is what makes a non-deterministic
system testable: the loop, the policy and the guards are unit-tested with no container, no
database and no network. Zod is the only schema language, and the OpenAI strict schema is
generated from the same object the runner validates against.

**Rejected.** An agent framework: the loop is forty lines and I need exact control over what
happens between the model asking for a refund and a refund happening — that control *is* the
assignment. A vector database, for seven documents. A job queue. The Responses API, since
state lives in Postgres.

**The boundary is code, not prompt.** `issue_refund` is `requires_approval` on its
descriptor, so the policy short-circuits before `execute` is reached and only
`POST .../approve` runs it. `open_incident` is autonomous: a redundant page costs an engineer
minutes, an unpaged regional outage on a 45-seat account costs the account. Guards then
correct the model every turn — a critical ticket is never auto-answered, a pending approval
anywhere on the ticket forces escalation, `tools_used` is rebuilt from what actually ran.
Separately, an operator's question re-triages and reads but may not act: acting is
`authorize_actions: true`, an explicit act rather than a wording.

**Ordering over one big transaction.** Ticket committed, turn opened, model run, decision
written. An LLM call inside a transaction pins a pool connection per in-flight ticket, which is
how a service with a healthy database stops serving traffic — and a provider outage cannot lose
a ticket, since the API returns a degraded escalation rather than a 5xx.

## Trade-offs under time

**Cut:** streaming, auth, deployment, a UI. Embeddings retrieval. Rate limits and cost caps.
Replaying prior turns' tool transcripts: only the previous decision is summarised, so tokens
grow linearly rather than quadratically.

**Cut, then put back.** A sweeper for rows stuck in `executing` was on the cut list until a
review pass pointed out that three states are leases with no expiry and none was visible to any
endpoint — a customer waiting forever for a reply nobody knows they are owed.
`ReconcilerService` closes all three; its limits are in the README.

**What the tests caught.** 226 unit and 77 end-to-end tests pass. The end-to-end suite found
approving an already-*rejected* refund returning success instead of `409`; a clean clone
following the README verbatim found the prompt file missing from the production build.

Classification was never the hard part. **Tool-call completeness was**, and it took five prompt
versions and four rules in code to go from 6/10 clean runs to 30/30. The lesson is one
sentence: **behaviour that must be reliable does not belong in a prompt.** v1 triaged ticket 1
perfectly and then called no tools at all, because "you may never move money" reads to a
cautious model as "do not touch this tool". Paging, injection flagging, answer grounding and
the holding-reply check are now rules in code; two of them were wrong on their first attempt,
both caught by re-running the harness rather than by reasoning. Read the baseline as one run:
the preceding run on an identical build scored 27/30 on two intermittent behaviours that
survive everything here.

**With another week,** in order: make approval execution asynchronous so an operator's request
does not wait on the payment provider; replace the keyword injection detector with a
classifier; grow a golden set from real human disagreements; cost budgets and provider
fallback; then auth.

## Failure modes, ticket by ticket

**Ticket 1 — three duplicate charges, angry, two-hour deadline.** The hardest failure to design
against is tone inflation: four escalating messages and a dispute threat read as `critical`,
but nothing is down and one user is affected. The prompt defines `critical` as outage, data
loss or a whole account blocked, states that tone is not urgency, and the eval asserts `high`.
Second: refunding all three charges cancels the purchase the customer wanted, so the duplicate
rule makes the first the intended one and the eval asserts exactly two pending refunds. Neither
is enforceable in code — a semantically wrong refund is still a well-formed refund — which is
why refunds need a human: the guard catches the class of error, the human catches the instance.
The judge caught the subtler third version: a draft calling all three charges duplicates while
only two refunds were filed. What the system does guarantee is that a retried request, a
double-clicked approval and a model that asks twice all yield one refund.

**Ticket 2 — Thai enterprise outage, status page says all clear.** The designed trap is
calling `check_service_status` without a region, reading "all systems operational", and
auto-responding "clear your cache" to a 45-seat account mid-incident. Three defences: the
region argument defaults to the customer's region inside the tool; the tool returns the regional
probe, the public page, and an explicit `agrees_with_public_page: false`; and the prompt states
that human-maintained status pages lag machine probes. Second: replying in English, or not at
all — the eval asserts Thai script and a holding reply. Third: KB search is useless here,
because the tokenizer fragments Thai and the one document it matches is hit only via the ASCII
substring `error 500`. Documented rather than pretending a lexical scorer is multilingual.

**Ticket 3 — dark mode, a bug plus a feature request, relaxed customer.** The failure is the
opposite of ticket 1: over-escalation. A prompt full of safety rules forwards routine how-to
questions to humans and destroys the product's value, so the prompt carries explicit
counter-pressure ("escalating is not free") and the eval asserts `auto_respond`. Second: a
single `issue_type` would drop the scheduling request, so the schema carries
`secondary_topics`. Third: this ticket is only answerable because the account lookup reveals
release `4.1.3` while the KB article explains the toggle ships in `4.2`. A model answering
from the article without checking the release would confidently tell a paying customer dark
mode does not exist — the grounding guard forces a relevant article to exist, and the judge
checks it was read correctly.

## Measuring this in production

Offline: the labelled set runs on every prompt or model change, gated on zero safety
violations and no accuracy regression, with `--repeat` separating improvement from noise.
Every decision stores its `prompt_version` and model, so any metric cohorts by prompt.

Online, ground truth is what the human did next, and it is free to collect: was the draft sent
unchanged, edited or discarded; did an operator change the urgency or action; was a requested
refund approved or rejected (rejection rate is the precision of the agent's financial
judgement); did an autonomous page turn out to be real; did an auto-responded ticket come back
within a day.

Without labels, watch distribution shift and guard activity: share marked critical, share
auto-responded, how often guards correct the model, how often the paging and injection rules
fire, degraded-turn rate, tokens and latency. Guards firing more often means the prompt is
drifting from the policy. A prompt change ships in shadow mode first, scored against live human
decisions before it is allowed to act.
