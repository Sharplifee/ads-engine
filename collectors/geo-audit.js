// SOURCE 1c — is the money pointed at the right map?
// Reads every ad set's live geography, compares it to the profile's service area,
// and raises an alert in plain words when they disagree. This is the check that
// catches the single most expensive AI-build mistake: right ad, wrong place.
import { db } from '../worker/db.js';
import { channelFor } from '../worker/channels/channel.js';
import { readGeo, compareGeo } from '../worker/geo.js';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const rules = YAML.parse(readFileSync(new URL('../engine/rules.default.yaml', import.meta.url), 'utf8'));

export async function auditGeo(profile) {
  const channel = await channelFor(profile);
  if (typeof channel.pullTargeting !== 'function')
    return { skipped: 'this channel cannot report targeting' };

  const intended = profile.market?.geo || {};
  const guard = { ...rules.guardrails, ...(profile.rules || {}) };
  const sets = await channel.pullTargeting(profile.ad_account_id);
  const today = new Date().toISOString().slice(0, 10);

  const findings = [];
  for (const s of sets) {
    const live = readGeo(s.geo_locations);
    const { problems, matched, extra, missing } = compareGeo({ intended, live, rules: guard });
    findings.push({ entity_id: s.entity_id, name: s.name, status: s.status,
                    live, problems, matched, extra, missing });
  }

  await db.from('ads_market_signals').upsert([{
    profile_slug: profile.slug, kind: 'geo', for_date: today,
    place: (intended.zips || intended.cities || intended.regions || []).slice(0, 3).join(', ') || null,
    value: {
      ad_sets: findings.length,
      clean: findings.filter(f => !f.problems.length).length,
      findings: findings.map(f => ({ name: f.name, status: f.status,
        targets: [...f.live.zips, ...f.live.cities.map(c => c.name), ...f.live.regions.map(r => r.name)].slice(0, 20),
        problems: f.problems }))
    }
  }], { onConflict: 'profile_slug,kind,for_date' });

  // One alert per ad set per problem kind, on the same cooldown as everything else.
  const cutoff = new Date(Date.now() - (guard.alert_cooldown_hours ?? 12) * 36e5).toISOString();
  let raised = 0;
  for (const f of findings) {
    if (f.status === 'DELETED' || f.status === 'ARCHIVED') continue;
    for (const p of f.problems) {
      const ruleId = `geo_${p.kind}`;
      const { data: recent } = await db.from('ads_alerts').select('id')
        .eq('profile_slug', profile.slug).eq('rule_id', ruleId)
        .eq('entity_id', f.entity_id).gte('raised_at', cutoff).limit(1);
      const evidence = { targeting: f.live, service_area: intended,
                         outside: f.extra, uncovered: f.missing, status: f.status };
      if (recent?.length) { await db.from('ads_alerts').update({ evidence }).eq('id', recent[0].id); continue; }
      await db.from('ads_alerts').insert({
        profile_slug: profile.slug, rule_id: ruleId, severity: p.severity,
        level: 'adset', entity_id: f.entity_id, entity_name: f.name,
        message: `${f.name}: ${p.message}`, evidence
      });
      raised++;
    }
  }

  return { ad_sets: findings.length, clean: findings.filter(f => !f.problems.length).length,
           alerts: raised,
           problems: findings.flatMap(f => f.problems.map(p => `${f.name}: ${p.message}`)) };
}
