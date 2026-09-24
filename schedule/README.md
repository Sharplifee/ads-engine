# Making it run without you
Pick one. Both call the same entry point; the runner decides what is due.

**Mac (launchd)** — copy the plist to ~/Library/LaunchAgents, edit the path, then
`launchctl load -w ~/Library/LaunchAgents/com.unnamed.ads.engine.plist`. Runs hourly,
survives reboots, stops when the Mac sleeps.

**Cloud (GitHub Actions)** — copy github-actions.yml into .github/workflows/ and add the
secrets. Runs whether or not anything of yours is on.

Check it is alive: `select * from ads_health();`
A missing row is the real alarm — an engine that stopped running looks exactly like an
engine with nothing to report.
