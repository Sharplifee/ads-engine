// SOURCE 2b — what media is actually getting attention and converting.
// Answers "what format, medium and length is working right now" from three angles:
// what survives in the market, what performs in this account, and what operators
// report. Written as a market signal, never applied on its own.
import { db } from '../worker/db.js';

export async function readFormatMix(profile) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();

  // 1. The market: which formats survive longest in this category.
  const { data: rivals } = await db.from('ads_competitor_ads')
    .select('format,days_running,angle,hook_type,advertiser')
    .eq('profile_slug', profile.slug).gte('seen_at', since);
  const market = {};
  for (const r of rivals || []) {
    const f = (r.format || 'unknown').toLowerCase();
    (market[f] ||= { count: 0, total_days: 0, advertisers: new Set() });
    market[f].count++; market[f].total_days += r.days_running || 0;
    market[f].advertisers.add(r.advertiser);
  }
  const marketMix = Object.entries(market).map(([format, m]) => ({
    format, ads: m.count, advertisers: m.advertisers.size,
    median_days_running: Math.round(m.total_days / m.count)
  })).sort((a, b) => b.median_days_running - a.median_days_running);

  // 2. This account: which formats actually produce results per dollar.
  const { data: mine } = await db.from('ads_snapshots')
    .select('name,raw,spend,results,ctr,cost_per_result,captured_at')
    .eq('profile_slug', profile.slug).eq('level', 'ad').gte('captured_at', since);
  const ours = {};
  for (const s of mine || []) {
    const f = (s.raw?.creative_format || guessFormat(s.name)).toLowerCase();
    (ours[f] ||= { spend: 0, results: 0, ctr: [], n: 0 });
    ours[f].spend += Number(s.spend) || 0; ours[f].results += Number(s.results) || 0;
    if (Number.isFinite(s.ctr)) ours[f].ctr.push(s.ctr); ours[f].n++;
  }
  const ourMix = Object.entries(ours).map(([format, o]) => ({
    format, spend: o.spend, results: o.results,
    cost_per_result: o.results ? o.spend / o.results : null,
    avg_ctr: o.ctr.length ? o.ctr.reduce((a, b) => a + b, 0) / o.ctr.length : null
  })).sort((a, b) => (a.cost_per_result ?? 1e9) - (b.cost_per_result ?? 1e9));

  // 3. Operators: adopted claims about creative and format.
  const { data: claims } = await db.from('ads_playbook')
    .select('claim,corroborations').eq('category', 'creative').eq('status', 'adopted').limit(25);

  const signal = {
    profile_slug: profile.slug, kind: 'format_mix',
    for_date: new Date().toISOString().slice(0, 10),
    place: (profile.market?.service_area || [])[0] || null,
    value: { market: marketMix, ours: ourMix, operator_claims: claims || [],
             gap: marketMix.filter(m => !ourMix.some(o => o.format === m.format)).map(m => m.format) }
  };
  await db.from('ads_market_signals').upsert([signal], { onConflict: 'profile_slug,kind,for_date' });
  return signal.value;
}

function guessFormat(name = '') {
  const n = name.toLowerCase();
  if (/(video|vid|reel|ugc|testimonial)/.test(n)) return 'video';
  if (/(carousel|carou)/.test(n)) return 'carousel';
  if (/(static|image|img|graphic)/.test(n)) return 'image';
  return 'unknown';
}
