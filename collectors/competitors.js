// SOURCE 2 — competitor ads, live.
// Meta's Ad Library API only returns commercial ads for EU/UK, so for US markets
// the working route is the public Ad Library via an Apify actor. Days running is
// the only honest public performance signal, so it is what we rank on.
import { db } from '../worker/db.js';
const APIFY = () => process.env.APIFY_TOKEN;
const ACTOR = () => process.env.APIFY_AD_LIBRARY_ACTOR || 'curious_coder~facebook-ads-library-scraper';

// The scraper takes real Ad Library search URLs. Building them here keeps the
// country, active-status and sort-by-newest choices in one place.
const libraryUrl = (term, country) =>
  'https://www.facebook.com/ads/library/?' + new URLSearchParams({
    active_status: 'active', ad_type: 'all', country,
    q: term, search_type: 'keyword_unordered', media_type: 'all'
  }).toString();

const daysBetween = (a, b) => Math.max(0, Math.round((b - a) / 864e5));

// This scraper returns unix SECONDS, not milliseconds and not a date string.
// Treating them as milliseconds put every ad in 1970 and reported 20,000 days running.
function asDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) {
    const n = Number(v);
    return new Date(n < 1e11 ? n * 1000 : n);     // seconds vs milliseconds
  }
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

export async function pullCompetitors(profile) {
  if (!APIFY()) throw new Error('APIFY_TOKEN missing — competitor pull cannot run');
  const terms = profile.market?.competitor_terms?.length
    ? profile.market.competitor_terms
    : [profile.market?.category, ...(profile.market?.service_area || [])].filter(Boolean);
  if (!terms.length) return { skipped: 'no competitor terms or service area in profile' };

  const country = profile.market?.country || 'US';
  const limit = profile.market?.competitor_limit || 100;
  const run = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR()}/run-sync-get-dataset-items?token=${APIFY()}&timeout=300`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      urls: terms.map(t => ({ url: libraryUrl(t, country), method: 'GET' })),
      count: limit, limitPerSource: Math.ceil(limit / terms.length),
      scrapeAdDetails: true,
      'scrapePageAds.activeStatus': 'active',
      'scrapePageAds.countryCode': country
    })
  });
  if (!run.ok) throw new Error(`Apify ${run.status}: ${(await run.text()).slice(0, 200)}`);
  const items = await run.json();

  const rows = items.map(a => {
    const firstSeen = asDate(a.start_date ?? a.startDate ?? a.ad_delivery_start_time
                             ?? a.start_date_formatted);
    const lastSeen = asDate(a.end_date ?? a.endDate);
    const stillRunning = !lastSeen || lastSeen > new Date();
    return {
      profile_slug: profile.slug,
      segment: profile.business_model || null,
      vertical: profile.market?.vertical || null,
      advertiser: a.pageName || a.page_name || a.advertiser,
      ad_archive_id: String(a.adArchiveId || a.ad_archive_id || a.id || ''),
      format: a.displayFormat || a.media_type || (a.videoUrls?.length ? 'video' : 'image'),
      body: (a.adText || a.ad_creative_body || a.snapshot?.body?.text
             || a.snapshot?.link_description || '').slice(0, 4000),
      first_seen: firstSeen ? firstSeen.toISOString().slice(0, 10) : null,
      days_running: firstSeen
        ? daysBetween(firstSeen, stillRunning ? new Date() : lastSeen) : null,
      snapshot_url: a.snapshotUrl || a.ad_snapshot_url || null,
      raw: a
    };
  }).filter(r => r.ad_archive_id);

  // Longest-running first: survival is the signal.
  rows.sort((x, y) => (y.days_running || 0) - (x.days_running || 0));
  if (rows.length) await db.from('ads_competitor_ads').upsert(rows, { onConflict: 'ad_archive_id' });
  return { found: rows.length, longest: rows[0]?.days_running ?? null };
}
