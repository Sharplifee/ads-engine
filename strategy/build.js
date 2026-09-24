// THE OUTPUT — everything the engine knows, turned into a campaign someone could run.
// Structure, budgets, audiences, geography, formats, angles, hooks, written copy,
// asset specs, test order and the thresholds that govern it. Nothing is published.
import { db } from '../worker/db.js';
import { readFormatMix } from '../collectors/formats.js';
import { whatIsWorking } from '../collectors/market-index.js';
import { resolveBaselines } from '../worker/baselines.js';
import { askJSON } from '../worker/ai.js';

const SYSTEM = `You are building a complete paid-media strategy from evidence supplied to you.
The business may have years of data, none at all, or may have chosen to ignore what it has.
Your output is equally complete in every case — a business with no history still gets
structure, budgets, audiences, formats, angles, hooks, written copy, a shot list, a test
order and thresholds. What changes is not how much you deliver, it is how you label it:
every number that came from the market rather than from this account is marked borrowed,
with what would replace it and when. Never stall for missing data; state the assumption,
make the call, and say what would change your mind.
Rules you must not break:
- Use only what is in the evidence. Never invent prices, claims, guarantees, reviews or results.
- Where evidence is missing, say what is missing and what would resolve it.
- Respect every platform constraint listed. Do not propose anything it forbids.
- Competitor ads are inspiration for ANGLES, never copy to reproduce.
- Real footage of the actual product or work. No AI imagery that misrepresents it.
- Judge formats on what the evidence shows is surviving and converting, not fashion.
Return ONLY JSON:
{summary, constraint, structure:[{campaign, objective, why, adsets:[{name, audience, geo,
 placements, budget_share_pct, why}]}], creative:[{name, angle, hook, format, medium, length,
 primary_text, headline, description, asset_spec, sourced_from}], test_plan:[{step, what,
 success_looks_like, decide_after}], thresholds:{kill, scale, change_frequency},
 budget:{daily_total, split_rationale, pacing}, missing_evidence:[]}`;

export async function buildStrategy(profileRow, { daily_budget } = {}) {
  const profile = { ...profileRow, ...profileRow.config };
  const since = new Date(Date.now() - 30 * 864e5).toISOString();

  const [formats, rivals, playbook, signals, ours, outcomes] = await Promise.all([
    readFormatMix(profile).catch(e => ({ error: String(e) })),
    db.from('ads_competitor_ads').select('advertiser,format,angle,hook_type,offer,body,days_running')
      .eq('profile_slug', profile.slug).order('days_running', { ascending: false }).limit(40)
      .then(r => r.data || []),
    db.from('ads_playbook').select('claim,category,status,corroborations')
      .in('status', ['adopted', 'candidate']).limit(60).then(r => r.data || []),
    db.from('ads_market_signals').select('kind,for_date,value')
      .eq('profile_slug', profile.slug).gte('for_date', since.slice(0, 10)).then(r => r.data || []),
    db.from('ads_snapshots').select('name,spend,results,ctr,cpm,cost_per_result')
      .eq('profile_slug', profile.slug).eq('level', 'ad').gte('captured_at', since)
      .then(r => r.data || []),
    db.rpc('ads_true_cost_per_win', { p_slug: profile.slug }).then(r => r.data || [], () => [])
  ]);

  const working = await whatIsWorking(profile.business_model).catch(() => []);
  const baselines = await resolveBaselines(profile).catch(e => ({ error: String(e) }));
  const cold = baselines?.mode !== 'blended' || baselines?.provisional;
  const evidence = {
    what_is_working_now: working,
    business: { model: profile.business_model, result: profile.primary_result,
                offer: profile.offer, audience: profile.audience_notes,
                messaging: profile.messaging, market: profile.market, brand: profile.brand,
                inferred_and_unconfirmed: profile.inferred || [] },
    data_position: { mode: baselines?.mode, confidence: baselines?.confidence,
                     numbers_are_borrowed: cold, where_they_came_from: baselines?.source,
                     recalibrates: baselines?.recalibrates_when, missing: baselines?.missing },
    money: { daily_budget: daily_budget ?? profile.goal?.daily_spend_ceiling,
             target_cost_per_result: profile.goal?.target_cost_per_result
                                     ?? baselines?.thresholds?.target_cost_per_result,
             how_that_target_was_set: baselines?.thresholds?.basis,
             thresholds: baselines?.thresholds },
    starting_formats: baselines?.formats_to_start_with,
    our_performance: ours.slice(0, 80),
    true_cost_per_won_job: outcomes.slice(0, 20),
    competitors_longest_running: rivals,
    format_evidence: formats,
    market_signals: signals,
    platform_rules: playbook.filter(p => p.category === 'policy'),
    operator_claims: playbook.filter(p => p.category !== 'policy')
  };

  const plan = await askJSON({ system: SYSTEM, max_tokens: 8000, deep: true,
    input: JSON.stringify(evidence).slice(0, 400000) });

  const { data: saved } = await db.from('ads_plans').insert({
    profile_slug: profile.slug, horizon: 'launch',
    situation: plan.summary, constraint_found: plan.constraint,
    moves: plan.structure, expected_effect: { budget: plan.budget, test_plan: plan.test_plan },
    evidence: { counts: { competitors: rivals.length, our_ads: ours.length,
                          claims: playbook.length, signals: signals.length },
                missing: plan.missing_evidence },
    state: 'proposed'
  }).select().single();

  if (plan.creative?.length)
    await db.from('ads_creative_briefs').insert(plan.creative.map(c => ({
      profile_slug: profile.slug, source: c.sourced_from || 'strategy', angle: c.angle,
      hook: c.hook, format: c.format, medium: c.medium,
      geo: (profile.market?.service_area || []).join('; '), offer: profile.offer?.headline_offer || '',
      copy: { primary_text: c.primary_text, headline: c.headline, description: c.description,
              length: c.length },
      asset_spec: c.asset_spec, naming: c.name, state: 'draft'
    })));

  return { plan_id: saved?.id, summary: plan.summary, constraint: plan.constraint,
           campaigns: plan.structure?.length || 0, creatives: plan.creative?.length || 0,
           data_mode: baselines?.mode, numbers_borrowed: cold,
           recalibrates: baselines?.recalibrates_when, missing: plan.missing_evidence || [] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = process.argv[2];
  const { data: p } = await db.from('ads_profiles').select('*').eq('slug', slug).single();
  console.log(JSON.stringify(await buildStrategy(p, { daily_budget: Number(process.argv[3]) || undefined }), null, 2));
}
