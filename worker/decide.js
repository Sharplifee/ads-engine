// Decision layer. Turns everything the engine knows into one plan for one account:
// what is happening, the single biggest constraint, and the ordered moves.
// It writes plans and creative briefs. It never executes anything.
import { db } from '../worker/db.js';
import { funnelBreak, stats } from './rules.js';


export async function buildPlan(profileOrRow, horizon = 'week') {
  const profile = profileOrRow.config ? { ...profileOrRow, ...profileOrRow.config } : profileOrRow;
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const [{ data: snaps }, { data: alerts }, { data: playbook }, { data: rivals }] = await Promise.all([
    db.from('ads_snapshots').select('*').eq('profile_slug', profile.slug).gte('captured_at', since),
    db.from('ads_alerts').select('*').eq('profile_slug', profile.slug).is('acknowledged_at', null),
    db.from('ads_playbook').select('*').eq('status', 'adopted'),
    db.from('ads_competitor_ads').select('*').eq('profile_slug', profile.slug).gte('seen_at', since)
  ]);

  const ads = (snaps || []).filter(s => s.level === 'ad');
  const latest = new Map();
  for (const s of ads) {
    const prev = latest.get(s.entity_id);
    if (!prev || new Date(s.captured_at) > new Date(prev.captured_at)) latest.set(s.entity_id, s);
  }
  const current = [...latest.values()];
  const baselines = {
    ctr: stats(ads.map(a => a.ctr)), cpm: stats(ads.map(a => a.cpm)),
    cost_per_result: stats(ads.map(a => a.cost_per_result))
  };
  const target = profile.goal?.target_cost_per_result ?? baselines.cost_per_result.mean;

  // The single biggest limiter: whichever broken stage accounts for the most spend.
  const bySpend = {};
  for (const a of current) {
    const fb = funnelBreak(a, baselines);
    bySpend[fb.stage] = (bySpend[fb.stage] || 0) + (a.spend || 0);
  }
  const [constraintStage] = Object.entries(bySpend).sort((x, y) => y[1] - x[1])[0] || ['none', 0];

  const winners = current.filter(a => target && a.cost_per_result && a.cost_per_result < target);
  const losers = current.filter(a => target && a.cost_per_result && a.cost_per_result > 2 * target);
  const totalSpend = current.reduce((t, a) => t + (a.spend || 0), 0);

  const moves = [];
  for (const l of losers)
    moves.push({ order: moves.length + 1, type: 'pause', entity_id: l.entity_id, entity_name: l.name,
      why: `costs $${l.cost_per_result.toFixed(2)} against a $${target.toFixed(2)} target` });
  for (const w of winners.slice(0, 3))
    moves.push({ order: moves.length + 1, type: 'budget_step', entity_id: w.entity_id, entity_name: w.name,
      step_pct: 20, why: `beats target at $${w.cost_per_result.toFixed(2)}` });
  if (constraintStage === 'attention')
    moves.push({ order: moves.length + 1, type: 'new_creative', count: 3,
      why: 'most spend sits behind ads that are not earning the click' });
  if (constraintStage === 'landing_to_action' || constraintStage === 'click_to_land')
    moves.push({ order: moves.length + 1, type: 'fix_destination',
      why: 'the break is after the click, so new creative would not help yet' });
  if (!current.length)
    moves.push({ order: 1, type: 'observe', why: 'no delivery yet — thresholds stay unset until 7 days of data' });

  const { data: plan } = await db.from('ads_plans').insert({
    profile_slug: profile.slug, horizon,
    situation: `${current.length} ads, $${totalSpend.toFixed(2)} spent in 14 days, ` +
               `${winners.length} beating target, ${losers.length} well past it`,
    constraint_found: constraintStage,
    moves,
    expected_effect: { reallocates: losers.reduce((t, l) => t + (l.spend || 0), 0) },
    evidence: { alerts: (alerts || []).map(a => a.id), rivals_seen: (rivals || []).length,
                playbook_applied: (playbook || []).map(p => p.id) }
  }).select().single();

  // Briefs: one per winner to extend, one per competitor angle we do not run.
  const briefs = [];
  for (const w of winners.slice(0, 3))
    briefs.push({ profile_slug: profile.slug, source: 'winner', source_ref: w.entity_id,
      angle: 'extend winning angle', format: 'same format, new hook',
      medium: profile.channel || 'meta', geo: (profile.market?.service_area || []).join('; '),
      offer: profile.offer?.headline_offer || '', asset_spec: 'real footage of the actual work or product',
      naming: profile.creative?.naming_convention || '' });
  const ourAngles = new Set(current.map(a => (a.name || '').toLowerCase()));
  for (const r of (rivals || []).slice(0, 20))
    if (r.angle && ![...ourAngles].some(n => n.includes(r.angle.toLowerCase())))
      briefs.push({ profile_slug: profile.slug, source: 'competitor_gap', source_ref: r.ad_archive_id,
        angle: r.angle, hook: r.hook_type, format: r.format, medium: profile.channel || 'meta',
        offer: r.offer, asset_spec: 'original execution — never a copy of their ad',
        naming: profile.creative?.naming_convention || '' });
  if (briefs.length) await db.from('ads_creative_briefs').insert(briefs);

  return { plan, briefs: briefs.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { data: profiles } = await db.from('ads_profiles').select('*');
  for (const p of profiles || []) {
    const profile = { ...p, ...p.config };
    const out = await buildPlan(profile, process.argv[3] || 'week');
    console.log(p.slug, '->', out.plan?.constraint_found, `${out.plan?.moves?.length || 0} moves`, `${out.briefs} briefs`);
  }
}
