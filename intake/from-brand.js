// THE FRONT DOOR — minimum information in, full profile out.
// Give it a website (and optionally an ad account id). It reads the site, works out
// what is sold, to whom, where, at what price, with what proof, and writes a profile
// the rest of the engine can run on. Everything it infers is marked inferred, so a
// human can correct it before anything spends money.
import { db } from '../worker/db.js';
import { askJSON } from '../worker/ai.js';

const strip = h => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

async function grab(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return await res.text();
}

// Brand look, taken from the site itself rather than invented.
function brandMarks(html) {
  const colors = [...new Set((html.match(/#[0-9a-f]{6}/gi) || []).map(c => c.toLowerCase()))].slice(0, 8);
  const fonts = [...new Set((html.match(/font-family:\s*([^;"}]+)/gi) || [])
    .map(f => f.split(':')[1].trim().split(',')[0].replace(/['"]/g, '')))].slice(0, 4);
  const og = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [])[1] || null;
  return { colors, fonts, og_image: og };
}

const ASK = `You are reading a company's own website. Return ONLY JSON:
{business_model, primary_result, offer:{headline_offer, price_point, proof:[]},
 audience_notes, service_area:[], category, competitor_terms:[],
 objections:[], differentiators:[], tone, confidence:{high:[],low:[]}}
business_model is one of lead_gen, ecommerce, appointments, subscription.
primary_result is one of lead, purchase, appointment, install.
service_area: real place names only if the site states them. competitor_terms: the
search phrases a rival would advertise under. Put anything you are guessing in
confidence.low. Never invent prices, claims, guarantees or locations.`;

export async function intakeFromBrand({ url, slug, ad_account_id, channel = 'meta', org_id = null }) {
  const home = await grab(url);
  const links = [...home.matchAll(/href=["']([^"']+)["']/g)].map(m => m[1])
    .filter(h => /about|service|pricing|product|review|contact|area/i.test(h)).slice(0, 6);
  const extra = [];
  for (const l of links) {
    try { extra.push(strip(await grab(new URL(l, url).href)).slice(0, 6000)); } catch {}
  }
  const corpus = [strip(home).slice(0, 20000), ...extra].join('\n\n---\n\n');

  let read;
  try { read = await askJSON({ system: ASK, max_tokens: 3000, input: corpus }); }
  catch { throw new Error('Could not read that site into a profile — check the URL'); }

  const profile = {
    slug, display_name: new URL(url).hostname.replace(/^www\./, ''),
    ad_account_id: ad_account_id || null, channel, org_id,
    business_model: read.business_model, primary_result: read.primary_result,
    config: {
      slug, website: url,
      goal: { target_cost_per_result: null, daily_spend_ceiling: null, monthly_budget: null },
      market: { service_area: read.service_area || [], country: 'US', category: read.category,
                competitor_terms: read.competitor_terms || [], competitor_limit: 100, language: 'en' },
      offer: read.offer, audience_notes: read.audience_notes,
      messaging: { objections: read.objections, differentiators: read.differentiators, tone: read.tone },
      brand: brandMarks(home),
      creative: { naming_convention: '{service}_{angle}_{format}_{version}',
                  allowed_formats: ['image', 'video', 'carousel'],
                  ai_imagery_of_product_allowed: false },
      downstream: { crm: 'none', crm_config: {}, counts_as_good_lead: '' },
      inferred: read.confidence?.low || [], confirmed: read.confidence?.high || []
    },
    autonomy: { auto_pause: false, auto_scale: false, max_changes_per_entity_per_day: 1 },
    state: 'observe'
  };

  await db.from('ads_profiles').upsert({ ...profile, updated_at: new Date().toISOString() });
  return { profile, needs_confirmation: profile.config.inferred, pages_read: 1 + extra.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, slug, acct] = process.argv.slice(2);
  console.log(JSON.stringify(await intakeFromBrand({ url, slug, ad_account_id: acct }), null, 2));
}
