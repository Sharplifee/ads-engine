// Thin Meta Graph client. No SDK, no surprises.
// Read the environment when a call is made, not when the file is imported, so a
// missing key breaks the call that needs it instead of every file that imports this.
const V = () => process.env.META_API_VERSION;
const TOKEN = () => process.env.META_ACCESS_TOKEN;

function BASE() {
  if (!V()) throw new Error('META_API_VERSION is not set — set it before the first Meta call');
  if (!TOKEN()) throw new Error('META_ACCESS_TOKEN is not set — set it before the first Meta call');
  return `https://graph.facebook.com/${V()}`;
}

// Meta throttles hard and fails transiently. Retry with backoff on the codes that
// are worth retrying, give up immediately on the ones that never get better.
const RETRYABLE = new Set([1, 2, 4, 17, 32, 341, 613]);   // transient + rate limit
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(url, init = {}, attempt = 0) {
  let res, body;
  try {
    res = await fetch(url, init);
    body = await res.json();
  } catch (netErr) {
    if (attempt < 4) { await sleep(2 ** attempt * 1000); return call(url, init, attempt + 1); }
    throw new Error(`Meta API unreachable after 5 tries: ${netErr}`);
  }
  if (res.ok && !body.error) return body;
  const e = body.error || {};
  const retry = res.status === 429 || res.status >= 500 || RETRYABLE.has(e.code);
  if (retry && attempt < 4) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || 2 ** attempt * 2000;
    await sleep(wait);
    return call(url, init, attempt + 1);
  }
  throw new Error(`Meta API ${res.status} code ${e.code ?? '?'}/${e.error_subcode ?? '?'}: ${e.message ?? res.statusText}`);
}

async function get(path, params = {}) {
  const url = new URL(`${BASE()}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  url.searchParams.set('access_token', TOKEN());
  return call(url);
}

async function post(path, payload) {
  return call(new URL(`${BASE()}/${path}`), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, access_token: TOKEN() })
  });
}

const FIELDS = [
  'campaign_id','campaign_name','adset_id','adset_name','ad_id','ad_name',
  'spend','impressions','clicks','ctr','cpm','frequency',
  'actions','cost_per_action_type','inline_link_clicks'
].join(',');

export async function pullLevel(accountId, level, datePreset = 'last_7d') {
  const out = [];
  let after = null;
  do {
    const page = await get(`act_${accountId}/insights`, {
      level, date_preset: datePreset, fields: FIELDS, limit: 200,
      ...(after ? { after } : {})
    });
    out.push(...(page.data || []));
    after = page.paging?.cursors?.after && page.paging?.next ? page.paging.cursors.after : null;
  } while (after);
  return out;
}

export async function pullEntities(accountId, edge) {
  // edge: campaigns | adsets | ads
  const page = await get(`act_${accountId}/${edge}`, {
    fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,created_time',
    limit: 500
  });
  return page.data || [];
}

export async function pauseEntity(entityId) {
  return post(entityId, { status: 'PAUSED' });
}

export async function setBudget(entityId, amountMinorUnits, { lifetime = false } = {}) {
  // Meta takes budgets in minor units (cents). Passing dollars silently overspends
  // by 100x, which is the single most expensive mistake in this API.
  const field = lifetime ? 'lifetime_budget' : 'daily_budget';
  return post(entityId, { [field]: Math.round(amountMinorUnits) });
}

export async function getEntity(entityId, fields = 'id,name,status,daily_budget,lifetime_budget') {
  return get(entityId, { fields });
}

// Creation always lands paused — the platform enforces it and so do we.
export async function createDraft({ accountId, level, payload }) {
  const edge = { campaign: 'campaigns', adset: 'adsets', ad: 'ads' }[level];
  if (!edge) throw new Error(`createDraft: unknown level "${level}"`);
  return post(`act_${accountId}/${edge}`, { ...payload, status: 'PAUSED' });
}

export async function uploadImage(accountId, imageUrl) {
  return post(`act_${accountId}/adimages`, { url: imageUrl });
}

export async function searchLibrary({ terms, country = 'US', limit = 50 }) {
  // Meta's own library API only returns commercial ads for EU/UK. Elsewhere this
  // returns nothing and the engine falls back to the scraper, rather than pretending.
  return get('ads_archive', { search_terms: terms, ad_reached_countries: [country],
    ad_type: 'ALL', ad_active_status: 'ACTIVE', limit,
    fields: 'id,page_name,ad_creative_bodies,ad_delivery_start_time,publisher_platforms' });
}
