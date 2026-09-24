// Runs every source for every profile. Each one is isolated: if one source fails,
// the others still land, and the failure is reported by name rather than hidden.
import { db } from '../worker/db.js';
import { pullCompetitors } from './competitors.js';
import { pullOperators } from './operators.js';
import { pullPolicy } from './policy.js';
import { pullDemand } from './demand.js';
import { pullOutcomes } from './outcomes.js';
import { runProfile } from '../worker/monitor.js';
import { rebuildMarketIndex } from './market-index.js';
import { readFormatMix } from './formats.js';
import { checkLanding } from './landing.js';
import { resolveBaselines } from '../worker/baselines.js';
import { buildPlan } from '../worker/decide.js';
import { sendPending } from '../worker/notify.js';
import { executeApproved } from '../worker/execute.js';
import { tagRivals } from './tag-rivals.js';
import { loadEnv, capabilities } from '../worker/env.js';


const SCHEDULE = {
  account: 'hourly', outcomes: 'hourly', notify: 'hourly', execute: 'hourly',
  tag_rivals: 'daily',
  operators: 'daily', market_index: 'daily', demand: 'daily', landing: 'daily',
  baselines: 'daily', formats: 'daily', plan: 'daily',
  competitors: 'weekly', policy: 'weekly'
};

// Local day boundary, not UTC — a "daily" job that flips at 6pm Mountain is a bug.
export function localHour(tz = process.env.TIMEZONE || 'America/Denver') {
  return Number(new Intl.DateTimeFormat('en-US',
    { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()));
}

export function dueNow(cadence, tz) {
  const h = localHour(tz);
  if (cadence === 'hourly') return true;
  if (cadence === 'daily') return h === 6;                 // early morning, local
  if (cadence === 'weekly') return h === 6 && new Date().getDay() === 1;  // Monday
  return true;
}

export async function runAll({ only, force = false } = {}) {
  const report = {};
  const { data: profiles } = await db.from('ads_profiles').select('*');

  const shared = [['operators', () => pullOperators()], ['policy', () => pullPolicy()],
                  ['tag_rivals', () => tagRivals()], ['market_index', () => rebuildMarketIndex()]];
  for (const [name, fn] of shared) {
    if (only && !only.includes(name)) continue;
    if (!only && !force && !dueNow(SCHEDULE[name])) { report[name] = 'not due'; continue; }
    try { report[name] = await fn(); } catch (e) { report[name] = { failed: String(e) }; }
  }

  for (const p of profiles || []) {
    const profile = { ...p, ...p.config };
    report[p.slug] = {};
    // Order matters: gather, then recalibrate on what was gathered, then decide.
    const perProfile = [
      ['account', () => runProfile(profile)],
      ['competitors', () => pullCompetitors(profile)],
      ['demand', () => pullDemand(profile)],
      ['outcomes', () => pullOutcomes(profile)],
      ['formats', () => readFormatMix(profile)],
      ['landing', () => checkLanding(profile)],
      ['baselines', () => resolveBaselines(profile)],
      ['plan', () => buildPlan(profile)]
    ];
    for (const [name, fn] of perProfile) {
      if (only && !only.includes(name)) continue;
      if (!only && !force && !dueNow(SCHEDULE[name])) { report[p.slug][name] = 'not due'; continue; }
      try { report[p.slug][name] = await fn(); }
      catch (e) { report[p.slug][name] = { failed: String(e) }; }
    }
  }
  for (const [name, fn] of [['execute', () => executeApproved()], ['notify', () => sendPending()]]) {
    if (only && !only.includes(name)) continue;
    try { report[name] = await fn(); } catch (e) { report[name] = { failed: String(e) }; }
  }

  // Every run is logged, so "did it actually run?" is answerable without guessing.
  const failures = JSON.stringify(report).match(/"failed"/g)?.length || 0;
  await db.from('ads_runs').insert({ jobs: only || null, report,
    failures, ok: failures === 0 }).then(() => {}, () => {});
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('capabilities:', JSON.stringify(loadEnv(), null, 2));
  const only = process.argv[2] && process.argv[2] !== '--force' ? process.argv[2].split(',') : null;
  const force = process.argv.includes('--force');
  console.log(JSON.stringify(await runAll({ only, force }), null, 2));
  console.log('\nintended cadence:', JSON.stringify(SCHEDULE));
}
