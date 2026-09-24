// SOURCE 1b — the page the ad sends people to. Without this the engine can say
// "the break is after the click" but never why. Loads the real page and checks the
// things that actually kill conversion.
import { db } from '../worker/db.js';

const strip = h => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export async function checkLanding(profile, url = profile.website) {
  if (!url) return { skipped: 'no landing page on the profile' };
  const started = Date.now();
  let res, html = '';
  try {
    res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
      redirect: 'follow', signal: AbortSignal.timeout(20000) });
    html = await res.text();
  } catch (e) {
    const finding = { profile_slug: profile.slug, kind: 'landing', for_date: new Date().toISOString().slice(0,10),
      place: url, value: { reachable: false, error: String(e).slice(0, 160),
        verdict: 'the page did not load — every click is being wasted' } };
    await db.from('ads_market_signals').upsert([finding], { onConflict: 'profile_slug,kind,for_date' });
    return finding.value;
  }

  const text = strip(html);
  const ms = Date.now() - started;
  const bytes = html.length;
  const forms = (html.match(/<form[\s>]/gi) || []).length;
  const phones = (text.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || []).length;
  const ctas = (text.match(/\b(get a (free )?quote|book|schedule|call now|get started|request|buy now|order)\b/gi) || []).length;
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const pixel = /connect\.facebook\.net|fbq\(/i.test(html);
  const https = url.startsWith('https://');

  const problems = [];
  if (ms > 4000) problems.push(`slow: ${(ms / 1000).toFixed(1)}s to first response`);
  if (bytes > 3_000_000) problems.push(`heavy page: ${(bytes / 1e6).toFixed(1)} MB of HTML`);
  if (!forms && !phones) problems.push('no form and no phone number — nowhere to convert');
  if (!ctas) problems.push('no clear call to action found');
  if (!viewport) problems.push('not set up for phones, where most ad clicks come from');
  if (!pixel) problems.push('no Meta pixel detected — results may not be tracked at all');
  if (!https) problems.push('not secure (http) — browsers will warn visitors');
  if (res.status >= 400) problems.unshift(`page returns ${res.status}`);

  const value = { reachable: true, status: res.status, ms, kb: Math.round(bytes / 1024),
    forms, phone_numbers: phones, call_to_actions: ctas, mobile_ready: viewport,
    pixel_detected: pixel, https, problems,
    verdict: problems.length ? problems[0] : 'nothing obviously broken on the page' };

  await db.from('ads_market_signals').upsert([{ profile_slug: profile.slug, kind: 'landing',
    for_date: new Date().toISOString().slice(0, 10), place: url, value }],
    { onConflict: 'profile_slug,kind,for_date' });
  return value;
}
