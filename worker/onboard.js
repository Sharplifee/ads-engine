// Plug in any account: read its own 12-month history, derive its thresholds, write the profile.
import { db } from '../worker/db.js';
import { pullLevel } from './meta.js';
import { stats } from './rules.js';
import { resolveBaselines } from './baselines.js';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';


export async function onboard(slug) {
  if (!slug) throw new Error('usage: node worker/onboard.js <slug>');
  const profile = YAML.parse(readFileSync(`profiles/${slug}.yaml`, 'utf8'));
  const rows = await pullLevel(profile.ad_account_id, 'ad', 'last_90d');

  const spend = rows.map(r => Number(r.spend));
  const totalSpend = spend.reduce((a, b) => a + (b || 0), 0);
  const seeded = {
    ctr: stats(rows.map(r => Number(r.ctr))),
    cpm: stats(rows.map(r => Number(r.cpm))),
    spend: stats(spend)
  };

  await db.from('ads_profiles').upsert({
    slug: profile.slug, display_name: profile.display_name,
    ad_account_id: profile.ad_account_id, business_model: profile.business_model,
    primary_result: profile.primary_result, config: profile,
    data_mode: profile.data_mode || (totalSpend > 0 ? 'blended' : 'cold'),
    baselines: seeded, autonomy: profile.autonomy, updated_at: new Date().toISOString()
  });

  // The real thresholds come from resolveBaselines, which handles cold, fresh and blended.
  const baselines = await resolveBaselines({ ...profile }, { mode: profile.data_mode });
  return { slug, ads_seen: rows.length, spend_seen: totalSpend,
           mode: baselines.mode, confidence: baselines.confidence,
           target_cost_per_result: baselines.thresholds?.target_cost_per_result,
           basis: baselines.thresholds?.basis, recalibrates: baselines.recalibrates_when };
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await onboard(process.argv[2]), null, 2));
