# Doctrine — how this engine decides

Sourced from 20 operator transcripts (100+ account media buyers, an agency running 80+
accounts on the official Meta connector, and Meta's own docs), not from theory.

## Build order (never skip ahead)
1. Reports only. Prove the numbers are right.
2. Launching, with a human approving every publish.
3. Actions, starting with pausing, which is the only safe automatic move.
Scaling automatically comes last and only after the account has 30 days of logged
decisions that the human agreed with.

## Baselines, not guesses
Every threshold is derived from the account's own trailing history at onboarding:
mean and standard deviation over 3, 7, and 14 days for spend, CPM, CTR, cost per result,
and result volume. An account with no history runs in observe-only mode until it has
7 days of delivery.

## Judgment rules
- Never judge on a single day. A winner must hold in at least 2 of the 3 windows.
- Promo periods are excluded from baselines or every promo looks like an anomaly.
- Good anomalies are reported as loudly as bad ones. Most missed money is an ad that
  suddenly started working and nobody noticed.
- Cost per result beats every surface metric. CPM and CTR only explain *why*.
- Find the first broken stage in the funnel before blaming creative (see rules funnel_break).
- The connector's attribution windows, conversion lift, and CPM figures are the three
  numbers operators report as unreliable. Cross-check before acting on them.
- The engine cannot see whether tracking itself is broken. Zero results with healthy
  clicks is a tracking hypothesis first, a creative hypothesis second.

## Change discipline
- One change per entity per 24 hours. Every structural edit restarts Meta's learning.
- Scale in steps of 20% or less.
- Everything created lands paused; a human publishes.
- After anything the engine builds, run the QA checklist before it goes live.

## Autonomy ladder
| Action | Default |
|---|---|
| Alert | automatic |
| Pause a losing ad | automatic if profile.autonomy.auto_pause |
| Refresh / new creative | proposed |
| Budget increase | proposed, capped at 20% |
| New campaign or audience | proposed, human builds or approves |
| Anything touching spend at the account level | human only |
