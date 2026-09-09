# Write-up

Setup, API and mechanics are in the [README](README.md). This is the reasoning.

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
Rate limits and cost caps. Replaying prior turns' tool transcripts: only the previous decision
is summarised, so tokens grow linearly rather than quadratically.

**Cut, then put back.** A sweeper for rows stuck in `executing` was on the cut list until a
review pass pointed out that three states are leases with no expiry and none of them was
visible to any endpoint — a customer waiting forever for a reply nobody knows they are owed.
`ReconcilerService` closes all three, and the two staleness numbers it derives are in the
README's Known limitations along with what they still do not cover.

**What the tests caught.** 212 unit and 77 end-to-end tests pass. The end-to-end suite found
approving an already-*rejected* refund returning success instead of `409`; following the README
verbatim in a clean clone found the prompt file missing from the production build and `pnpm
setup` silently shadowed by pnpm's own built-in command, which would have left a grader running
against an empty database. **No accuracy number is claimed and the
prompt is v1-unverified.** The eval set exists so that the first hour with a key produces
numbers instead of impressions.

**Who a turn speaks for.** Every message after the first re-runs the whole turn, which is
what lets a fourth angry customer message raise the urgency — and it means the newest
decision speaks for the ticket. Reproduced against Postgres: an operator asking "any update?"
produced a grounded `auto_respond`, and the ticket left the human queue with a refund still
pending, because `pending_side_effect_ids` is derived from the turn's own tool records. Three
things follow from that, and they are separate decisions rather than one fix. The pending
count is now read per *ticket*, so no later turn answers over a decision a human is holding.
An operator's question re-triages and reads but does not act; acting is
`authorize_actions: true`, an explicit act rather than a wording. And `messages.visibility`
says which rows the customer is party to, because `agentReply` is the operator summary and
the customer-facing draft is never written to the thread at all — that was true before and
nothing said so.

**With another week,** in order: make approval execution asynchronous so an operator's request
does not wait on the payment provider; replace the keyword
injection detector with a classifier; grow a golden set from real human disagreements and
judge it with a stronger model than the one being judged; cost budgets and provider fallback;
then auth.

## What the live eval measured

30 runs over 10 labelled tickets against `gpt-4.1-mini`, `--repeat 3`: every classification
field inside its accepted label set on every run, zero safety violations, ~6 s and ~8k tokens
per ticket. Read that as one run rather than a guarantee — the run before it, on an identical
build, scored 27/30 on two intermittent behaviours that survive everything here: the model
occasionally files no refund requests on ticket 1, and occasionally returns `und` for a plainly
English ticket.

Classification was never the hard part. **Tool-call completeness was**, and it took four prompt
versions and four rules in code to go from 6/10 clean runs to 30/30, with
[eval/FINDINGS.md](eval/FINDINGS.md) as the blow-by-blow. The lesson is one sentence:
**behaviour that must be reliable does not belong in a prompt.** v1 triaged ticket 1 perfectly
then called no tools at all, because "you may never move money" reads to a cautious model as "do
not touch this tool". Ticket 2 wrote "confirming a real regional outage" and paged nobody in a
third of runs. On ticket 5 the model **complied with the injection**, filing refunds against all
three charges and choosing `auto_respond` to tell the customer the money was on its way — and
nothing moved, because `issue_refund` is unreachable without a human and the guard rewrote the
action. Paging, injection flagging, answer grounding and the holding-reply check are now rules
in code; two of them were wrong on their first attempt, both caught by re-running the harness
rather than by reasoning.

No guard can check whether the reply says what the evidence says, so `--judge` puts an
LLM-as-judge over the draft and the gathered evidence, using `gpt-4.1` rather than the model
being judged. It found the error worth finding: two refunds correctly requested out of three
charges, and a reply telling the customer all three were duplicates. But the judge is an
instrument, and eleven known-answer cases calibrate it because it needed correcting three times
— it caught a case *I* had mislabelled, it was readable by the injection in a ticket it was
judging, and it marked a correct draft wrong until given the policy that draft was written
under. Its verdict stays advisory and out of the request path.

## Failure modes, ticket by ticket

**Ticket 1 — three duplicate charges, angry, two-hour deadline.** The hardest failure to design
against is tone inflation: four escalating messages and a dispute threat read as `critical`,
but nothing is down and one user is affected. The prompt defines `critical` as outage, data
loss or a whole account blocked, states that tone is not urgency, and the eval asserts `high`,
which it hit in every live run. Second: refunding all three charges cancels the purchase the
customer wanted, so the duplicate rule makes the first the intended one and the eval asserts
exactly two pending refunds. Neither is enforceable in code — a semantically wrong refund is
still a well-formed refund — which is why refunds need a human: the guard catches the class of
error, the human catches the instance. The judge caught the third, subtler version: a draft
telling the customer all three charges were duplicates while only two refunds were filed. What
the system does guarantee is that a retried request, a double-clicked approval and a model that
asks twice all yield one refund.

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
counter-pressure ("escalating is not free") and the eval asserts `auto_respond`, clean in every
live run with the secondary topic captured. Second: a single `issue_type` would drop the
scheduling request, so the schema carries `secondary_topics`. Third: this ticket is only
answerable because the account lookup reveals release `4.1.3` while the KB article explains the
toggle ships in `4.2`. A model answering from the article without checking the release would
confidently tell a paying customer dark mode does not exist — the grounding guard forces a
relevant article to exist, and the judge checks it was read correctly.

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
