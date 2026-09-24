# Deploy
1. Run `db/schema.sql` in the Supabase project.
2. Put the values from `.env.example` in the environment. `META_ACCESS_TOKEN` must be a
   long-lived token for a system user with ads_read and ads_management on the accounts
   you plug in. `META_API_VERSION` must be set explicitly.
3. `npm install`
4. Onboard an account: `node worker/onboard.js <slug>`
5. Schedule `node worker/monitor.js` hourly (launchd on the Mac, or any host that stays up).
6. Optional second layer: create Meta automated rules in Ads Manager for the hard
   safety stops, so the floor holds even if this worker is down.

## Order of trust when turning things on
Week 1: monitor only, auto_pause false. Read the alerts, argue with them.
Week 2: auto_pause true once the pause alerts have been right consistently.
Week 3+: scaling stays proposed until the action log shows agreement over 30 days.
