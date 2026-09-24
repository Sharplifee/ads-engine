// THE LIVE PICTURE — "what is working right now", by how the money is made and by
// format. Rebuilt daily from three independent angles so no single one can mislead:
//   survival  — how long live ads in this segment keep running (market vote)
//   results   — what actually converts across every account the engine runs (our vote)
//   reported  — what operators publish, weighted by how many said it (field vote)
// It is a picture, never an instruction. The decision layer reads it; nothing applies it.
import { db } from '../worker/db.js';
import { segments, formats } from '../discovery/queries.js';

const median = a => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y);
  const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };

export async function rebuildMarketIndex({ windowDays = 30 } = {}) {
  const since = new Date(Date.now() - windowDays * 864e5).toISOString();
  const rows = [];

  const [{ data: rivals }, { data: ours }, { data: claims }, { data: profiles }] = await Promise.all([
    db.from('ads_competitor_ads').select('segment,vertical,format,days_running,angle,hook_type,advertiser')
      .gte('seen_at', since),
    db.from('ads_snapshots').select('profile_slug,name,raw,spend,results,ctr,cost_per_result,captured_at')
      .eq('level','ad').gte('captured_at', since),
    db.from('ads_playbook').select('claim,category,segment,corroborations,status').gte('added_at', since),
    db.from('ads_profiles').select('slug,business_model')
  ]);

  const modelOf = Object.fromEntries((profiles||[]).map(p => [p.slug, p.business_model]));

  for (const segment of segments()) {
    for (const format of formats()) {
      const f = format.replace(/_/g,' ');

      const surv = (rivals||[]).filter(r =>
        (r.segment === segment || !r.segment) &&
        String(r.format||'').toLowerCase().includes(f.split(' ')[0]));
      const survival = { ads: surv.length, advertisers: new Set(surv.map(r=>r.advertiser)).size,
        median_days_running: median(surv.map(r=>r.days_running).filter(Number.isFinite)),
        top_angles: [...new Set(surv.sort((a,b)=>(b.days_running||0)-(a.days_running||0))
          .map(r=>r.angle).filter(Boolean))].slice(0,5) };

      const mine = (ours||[]).filter(s => modelOf[s.profile_slug] === segment &&
        `${s.name||''} ${s.raw?.creative_format||''}`.toLowerCase().includes(f.split(' ')[0]));
      const spend = mine.reduce((t,s)=>t+(Number(s.spend)||0),0);
      const results = mine.reduce((t,s)=>t+(Number(s.results)||0),0);
      const performance = { accounts: new Set(mine.map(s=>s.profile_slug)).size, spend, results,
        cost_per_result: results ? spend/results : null,
        median_ctr: median(mine.map(s=>s.ctr).filter(Number.isFinite)) };

      const said = (claims||[]).filter(c => (c.segment === segment || !c.segment) &&
        String(c.claim).toLowerCase().includes(f.split(' ')[0]));
      const reported = { claims: said.length,
        strongest: said.sort((a,b)=>(b.corroborations||1)-(a.corroborations||1))[0]?.claim || null };

      const evidence = [survival.ads>0, performance.results>0, reported.claims>0].filter(Boolean).length;
      if (!evidence) continue;

      rows.push({ segment, format, window_days: windowDays,
        survival, performance, reported,
        confidence: evidence === 3 ? 'high' : evidence === 2 ? 'medium' : 'low',
        for_date: new Date().toISOString().slice(0,10) });
    }
  }

  if (rows.length) await db.from('ads_market_index')
    .upsert(rows, { onConflict: 'segment,format,for_date' });
  return { segments: segments().length, rows: rows.length,
    high_confidence: rows.filter(r=>r.confidence==='high').length };
}

// What the decision layer asks: "for this kind of business, what is working now?"
export async function whatIsWorking(business_model) {
  const { data } = await db.from('ads_market_index').select('*')
    .eq('segment', business_model).order('for_date', { ascending: false }).limit(40);
  return (data||[]).sort((a,b) =>
    (b.survival?.median_days_running||0) - (a.survival?.median_days_running||0));
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await rebuildMarketIndex(), null, 2));
