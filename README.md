# Unnamed — autonomous Meta ads management engine

Brand-agnostic. The engine knows how to run Meta ads. A **profile** plugs in one account
(any business, any vertical, any offer) and the engine adapts its thresholds to that
account's own history instead of using guessed numbers.

```
collectors/            <- the six sources that feed the engine (see collectors/README.md)
profiles/<slug>.yaml   <- the only per-client file
engine/doctrine.md     <- how decisions get made (shared)
engine/rules.default.yaml <- default kill / scale / spend rules (shared)
engine/prompts/        <- the runnable prompt pack (shared)
worker/channels/       <- one adapter per ad platform (meta today, others drop in)
worker/                <- monitor, rules engine, decision layer (Node, no Claude needed)
db/schema.sql          <- Supabase tables
learn/                 <- self-updating playbook from YouTube/podcast transcripts
```

Full layer-by-layer blueprint: `docs/architecture.md`.
Every account carries its own trust state — observe, advise, then act — and earns
its way up. One org can hold many accounts across many channels.

## Three layers, in order of trust
1. **Meta automated rules** (inside Ads Manager) — instant, dumb safety net. Runs even if
   everything else is down.
2. **Worker** (this repo) — hourly pull of every campaign/ad set/ad, writes snapshots,
   evaluates rules, raises alerts, writes *proposed* actions. Never spends.
3. **Claude** (Meta connector + this repo's prompts) — judgment, diagnosis, creative,
   and the only path to a change, always behind human approval.

## Three ways in — all produce the same complete output
1. **Website** — `node intake/from-brand.js <url> <slug> [account]`
2. **Six questions** — no site, no account, no data at all (see intake/from-answers.js)
3. **Existing account** — `node worker/onboard.js <slug>`

And three data positions, set as `data_mode` on the profile: `cold` (nothing yet),
`fresh` (history exists but the owner wants a clean slate), `blended` (history leads).
A business with no data still gets the full plan — structure, budgets, audiences,
formats, angles, hooks, copy, shot list, test order and thresholds. The only difference
is that borrowed numbers are labelled borrowed, and they recalibrate automatically once
the account reaches 30 results or 14 days of delivery.

## Onboarding an existing account
1. Copy `profiles/_template.yaml` to `profiles/<slug>.yaml`, fill in 8 fields.
2. Run `node worker/onboard.js <slug>` — pulls 12 months of history, computes that
   account's own baselines, writes `profiles/<slug>.baselines.json`.
3. Run `node worker/monitor.js` on a schedule (hourly).
4. Use the prompts in `engine/prompts/` for anything that needs judgment.

## Not verified this session
- The Meta Graph API version is set by `META_API_VERSION` in `.env`. I did not confirm the
  current version number this session — set it before first run.
- Nothing in `worker/` has been executed against a live account yet.
