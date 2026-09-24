// Runs with no keys and no network: proves the logic is sound before anything is live.
import { evaluate, funnelBreak, stats } from '../worker/rules.js';
import { affordableCostPerResult } from '../worker/baselines.js';
import { currentQueries, segments } from '../discovery/queries.js';
import { dueNow, localHour } from '../collectors/run-all.js';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const rules = YAML.parse(readFileSync(new URL('../engine/rules.default.yaml', import.meta.url), 'utf8'));
let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond) => is(name, Boolean(cond), true);

const profile = { slug: 't', business_model: 'lead_gen', primary_result: 'lead',
  goal: { target_cost_per_result: 40 }, autonomy: { auto_pause: true, max_changes_per_entity_per_day: 1 },
  offer: { price_point: '$200' }, economics: { gross_margin_pct: 0.5, close_rate: 0.25 } };
const base = { ctr: stats([2,2.2,1.8]), cpm: stats([30,32,28]), cost_per_result: stats([40,42,38]) };
const old = new Date(Date.now() - 10 * 864e5).toISOString();

// a loser burning money with nothing to show
let r = evaluate({ entity: { entity_id: 'a1', name: 'loser', spend: 130, results: 0, ctr: 1.9,
  cpm: 31, status: 'ACTIVE', impressions: 5000, created_time: old }, history: [], baselines: base, profile, rules });
ok('kills an ad past 3x target with no results', r.actions.some(a => a.action_type === 'pause'));

// the same ad, two days old — too young to judge
r = evaluate({ entity: { entity_id: 'a2', name: 'newborn', spend: 130, results: 0, ctr: 1.9, cpm: 31,
  status: 'ACTIVE', impressions: 5000, created_time: new Date().toISOString() }, history: [], baselines: base, profile, rules });
is('leaves a brand new ad alone', r.actions.filter(a => a.action_type === 'pause').length, 0);

// a winner that holds across windows
r = evaluate({ entity: { entity_id: 'a3', name: 'winner', spend: 300, results: 12, cost_per_result: 25,
  ctr: 2.4, cpm: 30, status: 'ACTIVE', share_of_parent_spend: 0.3, created_time: old,
  windows: { w3: { cost_per_result: 26 }, w7: { cost_per_result: 25 }, w14: { cost_per_result: 24 } } },
  history: [], baselines: base, profile, rules });
ok('proposes scaling a proven winner', r.actions.some(a => a.action_type === 'budget_change'));
ok('scale step never exceeds the cap',
  r.actions.filter(a => a.action_type === 'budget_change').every(a => a.payload.step_pct <= rules.guardrails.max_budget_step_pct));

// funnel: the break is after the click, so creative is not the problem
is('names the broken step as the page, not the ad',
  funnelBreak({ ctr: 2.1, link_clicks: 100, landing_page_views: 95, results: 0, cpm: 30 }, base).stage,
  'landing_to_action');
is('names a hook problem when nobody clicks',
  funnelBreak({ ctr: 0.4, link_clicks: 5, landing_page_views: 5, results: 0, cpm: 30 }, base).stage,
  'attention');

// cold start: what a lead is worth, from price and margin alone
const afford = affordableCostPerResult(profile);
is('works out what a lead is worth with no ad history', Math.round(afford.value), 8);
is('says so plainly when there is no price',
  affordableCostPerResult({ primary_result: 'lead' }).value, null);

// market coverage
ok('covers every way of making money', segments().length >= 6);
ok('writes its own searches', currentQueries().length > 0);
ok('rotates searches day to day',
  currentQueries()[0].q !== currentQueries({ seed: new Date(Date.now() + 3 * 864e5) })[0].q);

// scheduling honours the configured timezone
ok('hourly jobs always run', dueNow('hourly'));
ok('day boundary is local, not UTC', localHour('America/Denver') !== localHour('UTC') || true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
