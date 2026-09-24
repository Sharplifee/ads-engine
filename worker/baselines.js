// WHERE THE NUMBERS COME FROM — the engine never refuses to work for lack of data.
// Three modes, set per profile:
//   cold    — no account history at all (new business, or a brand new account)
//   fresh   — history exists but the owner wants it ignored: clean slate on purpose
//   blended — history exists and is trusted: the account's own numbers lead
// Every threshold carries where it came from and how confident it is, so nobody
// mistakes a borrowed number for a proven one.
import { db } from '../worker/db.js';
import { stats } from './rules.js';
import { whatIsWorking } from '../collectors/market-index.js';

const median = a => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y);
  const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };

// What a result is worth, worked out from the business itself rather than guessed.
export function affordableCostPerResult(profile) {
  const price = Number(String(profile.offer?.price_point || '').replace(/[^0-9.]/g, '')) || null;
  const margin = profile.economics?.gross_margin_pct ?? 0.5;
  const closeRate = profile.economics?.close_rate ?? null;          // leads -> customers
  const repeat = profile.economics?.repeat_purchases ?? 1;          // lifetime multiple
  if (!price) return { value: null, how: 'no price on file — ask the owner one question' };
  const customerValue = price * margin * repeat;
  if (profile.primary_result === 'purchase')
    return { value: customerValue * 0.3, how: 'about a third of gross profit per sale' };
  const cr = closeRate ?? 0.2;                                      // conservative default, stated
  return { value: customerValue * cr * 0.3,
           how: `about a third of gross profit, at a ${Math.round(cr*100)}% close rate` };
}

export async function resolveBaselines(profile, { mode } = {}) {
  const dataMode = mode || profile.data_mode || 'blended';
  const out = { mode: dataMode, source: [], confidence: 'low', thresholds: {}, provisional: true,
                recalibrates_when: null, missing: [] };

  // 1. The account's own history, unless deliberately ignored
  let own = null;
  if (dataMode === 'blended') {
    const { data: hist } = await db.from('ads_snapshots')
      .select('ctr,cpm,cost_per_result,spend,results')
      .eq('profile_slug', profile.slug).eq('level', 'ad')
      .gte('captured_at', new Date(Date.now() - 90 * 864e5).toISOString());
    const results = (hist || []).reduce((t, r) => t + (Number(r.results) || 0), 0);
    if (results >= 30) {
      own = { ctr: stats((hist||[]).map(h=>h.ctr)), cpm: stats((hist||[]).map(h=>h.cpm)),
              cost_per_result: stats((hist||[]).map(h=>h.cost_per_result)), results };
      out.source.push(`own history (${results} results)`);
      out.confidence = 'high'; out.provisional = false;
    } else if (results > 0) {
      out.missing.push(`only ${results} results on file — not enough to trust yet`);
    }
  }
  if (dataMode === 'fresh') out.source.push('existing history deliberately ignored');

  // 2. The market, for this kind of business — what rivals sustain and what converts elsewhere
  const index = await whatIsWorking(profile.business_model).catch(() => []);
  const crossAccount = index.map(r => r.performance?.cost_per_result).filter(Number.isFinite);
  const marketCPR = median(crossAccount);
  if (index.length) out.source.push(`market index for ${profile.business_model} (${index.length} rows)`);

  // 3. The business's own economics — the strongest signal when there is no history
  const afford = affordableCostPerResult(profile);
  if (afford.value) out.source.push(`what a result is worth: ${afford.how}`);
  else out.missing.push('price point');

  // Pick the target: own > affordable > market > nothing (and say which)
  const target = own?.cost_per_result?.mean ?? afford.value ?? marketCPR ?? null;
  const basis = own ? 'own history' : afford.value ? 'unit economics' : marketCPR ? 'market index' : 'none';
  if (!target) out.missing.push('no price, no history, no market rows — engine runs in observe-only');

  out.thresholds = {
    target_cost_per_result: target, basis,
    kill_spend_multiple: own ? 3 : 2,         // cold accounts cut losses sooner
    scale_step_pct: own ? 20 : 10,            // and scale more carefully
    min_results_before_judging: own ? 3 : 5,
    learning_budget_per_test: target ? Math.round(target * (own ? 3 : 5)) : null,
    ctr_floor: own?.ctr?.mean ? own.ctr.mean * 0.5 : null,
    cpm_ceiling: own?.cpm?.mean ? own.cpm.mean * 1.5 : null
  };
  out.confidence = own ? 'high' : (afford.value && index.length) ? 'medium' : 'low';
  out.recalibrates_when = own ? 'continuously' :
    `automatically once this account reaches 30 results or 14 days of delivery`;
  out.formats_to_start_with = index.slice(0, 3).map(r => ({ format: r.format,
    why: `rivals in ${profile.business_model} sustain this longest`, confidence: r.confidence }));

  await db.from('ads_profiles').update({ baselines: out, updated_at: new Date().toISOString() })
    .eq('slug', profile.slug);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { data: p } = await db.from('ads_profiles').select('*').eq('slug', process.argv[2]).single();
  console.log(JSON.stringify(await resolveBaselines({ ...p, ...p.config }, { mode: process.argv[3] }), null, 2));
}
