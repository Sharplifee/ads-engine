# The learning loop
1. Weekly, pull new videos/podcasts from the watchlist (Scribbly handles transcription).
2. `node learn/ingest.js` turns each transcript into specific claims in `ads_playbook`.
3. Claims start as `candidate`. They are visible to Claude when it reasons about an
   account, clearly labelled as untested.
4. A claim is promoted to `adopted` only by testing it on a real profile, or by three
   independent operators saying the same thing.
5. Adopted claims that later fail on an account are marked `tested_failed` with the
   profile and date, so the same idea does not come back next quarter.

The feed never changes a threshold on its own. It proposes; the account decides.
