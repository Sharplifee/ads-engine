# The six sources
Each collector writes to the database and nothing else. None of them change a
setting, a budget, or an ad. They are the engine's senses, not its hands.

| # | Source | File | Writes to | Needs |
|---|--------|------|-----------|-------|
| 1 | Your own account history | worker/monitor.js | ads_snapshots | Meta token |
| 2 | Competitor ads, live | collectors/competitors.js | ads_competitor_ads | Apify token |
| 3 | What operators are saying | collectors/operators.js + discovery/* | ads_media, ads_playbook | YouTube key, Supadata or Apify, Firecrawl, Claude key |
| 4 | Platform rules and limits | collectors/policy.js | ads_playbook (policy) | none |
| 5 | Season, weather, demand | collectors/demand.js | ads_market_signals | none (open-meteo) |
| 6 | What leads actually closed | collectors/outcomes.js | ads_outcomes | per-profile CRM config |

Run them all: `node collectors/run-all.js` (safe to run repeatedly — every
collector is idempotent on its natural key).

## Discovery — the engine finds its own material
`discovery/youtube.js` follows the watchlist's channels for new uploads AND runs its
search phrases, so it also finds operators nobody told it about. Transcripts come from
Supadata, falling back to an Apify actor; a video with no transcript is stored with an
honest null rather than a guess. `discovery/podcasts.js` finds shows through iTunes
(no key) and reads their RSS feeds. `discovery/web.js` searches the open web through
Firecrawl for anything the other two miss. Everything lands in `ads_media`, is read
once, and is marked processed so nothing is read twice.

No part of this depends on any other project.
