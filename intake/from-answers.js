// THE SHORTEST WAY IN — no website, no account, no data. Six questions.
// Everything else the engine fills from the market for that kind of business, and
// marks as borrowed until the account produces numbers of its own.
import { db } from '../worker/db.js';
import { resolveBaselines } from '../worker/baselines.js';
import { askJSON } from '../worker/ai.js';

export const QUESTIONS = [
  { key: 'what',    ask: 'What do you sell, in one sentence?' },
  { key: 'who',     ask: 'Who buys it?' },
  { key: 'where',   ask: 'Where do you serve or ship?' },
  { key: 'price',   ask: 'What does it cost, roughly?' },
  { key: 'result',  ask: 'What counts as a win — a sale, a lead, a booking, an install?' },
  { key: 'budget',  ask: 'What can you spend per day to find out if this works?' }
];

const RESULT = { sale: 'purchase', purchase: 'purchase', lead: 'lead', booking: 'appointment',
                 appointment: 'appointment', install: 'install' };
const MODEL = { purchase: 'one_time_sale', lead: 'lead_gen',
                appointment: 'appointment', install: 'app_install' };

export async function intakeFromAnswers({ slug, answers, ad_account_id = null, channel = 'meta',
                                          data_mode = 'cold', org_id = null }) {
  const result = RESULT[String(answers.result || '').toLowerCase().split(/\s+/)[0]] || 'lead';
  const model = answers.business_model || MODEL[result];

  // One model call to turn six plain answers into the fields the engine uses.
  let read;
  try {
    read = await askJSON({ max_tokens: 2000, input: answers,
      system: `Turn a business owner's short answers into ad targeting inputs. Return ONLY JSON:
{category, vertical, competitor_terms:[], service_area:[], audience_notes, objections:[],
 differentiators:[], angles:[], assumptions:[]}
vertical: home_services | health_and_fitness | real_estate | ecommerce_physical | software_saas |
education_courses | finance_insurance | automotive | local_retail | professional_services.
angles: the 3-5 reasons this buyer acts, each one testable as an ad.
Put anything you had to assume in assumptions. Invent nothing about price, proof or location.` });
  } catch { read = { assumptions: ['could not read the answers — fields left blank'] }; }

  const config = {
    slug, data_mode,
    goal: { target_cost_per_result: null,
            daily_spend_ceiling: Number(String(answers.budget||'').replace(/[^0-9.]/g,'')) || null },
    market: { service_area: read.service_area || [answers.where].filter(Boolean), country: 'US',
              category: read.category, vertical: read.vertical,
              competitor_terms: read.competitor_terms || [], competitor_limit: 100 },
    offer: { headline_offer: answers.what, price_point: answers.price, proof: [] },
    audience_notes: read.audience_notes || answers.who,
    messaging: { objections: read.objections, differentiators: read.differentiators,
                 angles: read.angles },
    economics: {},
    creative: { naming_convention: '{angle}_{format}_{version}',
                allowed_formats: ['image','video','carousel'], ai_imagery_of_product_allowed: false },
    downstream: { crm: 'none', crm_config: {}, counts_as_good_lead: '' },
    inferred: read.assumptions || []
  };

  const profile = { slug, display_name: answers.what?.slice(0, 60) || slug, ad_account_id, channel,
    org_id, business_model: model, primary_result: result, config,
    autonomy: { auto_pause: false, auto_scale: false, max_changes_per_entity_per_day: 1 },
    state: 'observe', updated_at: new Date().toISOString() };

  await db.from('ads_profiles').upsert(profile);
  const baselines = await resolveBaselines({ ...profile, ...config }, { mode: data_mode });
  return { profile, baselines, assumed: config.inferred };
}
