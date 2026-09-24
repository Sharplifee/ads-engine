# Competitor pull (weekly)
For {{competitor_set}} in {{service_area}}:
1. Prefer the connector's Ad Library search. If it returns nothing for this market,
   fall back to the Ad Library site or an Apify Ad Library actor.
2. Sort by impressions high to low; long-running high-impression ads are their winners.
3. Tag every ad: format, hook type, angle, offer, days running, first seen.
4. Diff against last week: new, changed, disappeared.
5. Write the gap: angles they own that we do not, and angles nobody is running.
Store rows in competitor_ads. Do not copy ads outright — they may already be worn out.
