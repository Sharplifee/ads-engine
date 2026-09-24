# Blueprint — full architecture

Seven layers. Each one only talks to the layer beside it, so any piece can be
replaced without touching the rest.

## 1. Identity and tenancy
`ads_orgs` is the paying customer. One org holds many accounts (`ads_profiles`),
each with its own channel, goal, ceilings and trust state. An agency with 40
accounts is 1 org and 40 profiles. Nothing is global: a rule change, a pause, or
a budget move is always scoped to one profile.

**Trust ladder, per account:** `observe` (watch and report only) → `advise`
(propose everything, execute nothing) → `act` (pause automatically, everything
that spends still waits for a human). An account earns its way up; it never
starts at the top.

## 2. Channel adapters
`worker/channels/*.js`. Each platform implements one fixed shape: pull entities,
pull insights, pause, set budget, create draft, search the ad library. Meta is
implemented. Anything else is a new file, not a rewrite. A channel that can't do
something exports `unsupported()` so the engine degrades honestly.

## 3. Collection
The hourly puller writes `ads_snapshots` — one row per entity per hour, per
account, forever. This is the memory the rest of the system reasons over, and the
reason the engine can tell a bad Tuesday from a real problem.

## 4. Baselines and rules
`worker/rules.js`. Pure functions, no network, testable. Thresholds come from the
account's own trailing history (3, 7, 14 and 21 day windows), never from borrowed
benchmarks. Produces alerts (what happened) and actions (what to do).

## 5. Market intelligence
Three inbound streams, all landing in the database, none of them allowed to change
a setting by themselves:
- **Own account** — snapshots and outcomes.
- **Live market** — competitor ads from the channel's ad library, tagged by format,
  hook, angle, offer and days running. Survival time is the only honest public
  signal of what works.
- **Operator layer** — transcripts of practitioners publishing what is converting
  now, turned into specific testable claims in `ads_playbook`, marked untested
  until proven on a real account or independently repeated.

## 6. Decision layer
`worker/decide.js`. This is the part that turns findings into a plan: what the
situation is, the single biggest constraint right now, and an ordered set of moves
covering spend allocation, kill and scale, audience, geography, format, medium and
message. Writes `ads_plans` and `ads_creative_briefs`. Every plan carries the
evidence that produced it. Nothing here executes.

## 6b. Getting in — three doors, one output
`intake/from-brand.js` (a website), `intake/from-answers.js` (six questions, no site,
no account, no data) and `worker/onboard.js` (an existing account). `worker/baselines.js`
then resolves thresholds by `data_mode`: cold, fresh or blended. Borrowed numbers are
labelled, and recalibrate at 30 results or 14 days.

## 7. Execution and record
Approved moves go back out through the channel adapter. Creation always lands
paused. Every change, by engine or human, is written to `ads_audit` with the state
before and after and the reason. That audit trail is both the safety net and, over
time, the outcome dataset that makes the product hard to copy. `worker/notify.js`
pushes unacknowledged alerts to one webhook — without delivery, an alert is just a row.

## Invariants — true regardless of channel, client or vertical
- One change per entity per 24 hours.
- Budget moves in steps of 20% or less.
- Nothing younger than 48 hours gets touched.
- Only pausing can ever be automatic; anything that increases spend needs a human.
- No decision is made on one day of data.
- Every alert and plan carries its evidence.
- Every claim from the learning feed is untested until proven on a live account.
