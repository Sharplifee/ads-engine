// SOURCE 5 — season, weather and demand.
// Two honest signals, no paid data: real weather for the service area (open-meteo,
// no key), and the account's own same-period-last-year performance. Together they
// answer "is now a good time to push" without guessing.
import { db } from '../worker/db.js';

// "Utah County, UT" finds nothing; "Provo" does. Try the whole string, then the
// first part, then the county seat style fallback, rather than silently giving up.
async function geocode(place) {
  const tries = [place, place.split(',')[0].trim(),
                 place.split(',')[0].replace(/\b(county|parish|borough)\b/i, '').trim()];
  for (const name of [...new Set(tries)].filter(Boolean)) {
    const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
    u.searchParams.set('name', name); u.searchParams.set('count', '1');
    u.searchParams.set('country', 'US');
    const r = await fetch(u);
    if (!r.ok) continue;
    const hit = (await r.json()).results?.[0];
    if (hit) return hit;
  }
  return null;
}

export async function pullDemand(profile) {
  const place = (profile.market?.service_area || [])[0];
  const signals = [];

  if (place) {
    const geo = await geocode(place);
    if (!geo) signals.push({ profile_slug: profile.slug, kind: 'weather', place,
      for_date: new Date().toISOString().slice(0, 10),
      value: { note: `could not locate "${place}" — use a city name in service_area` } });
    if (geo) {
      const u = new URL('https://api.open-meteo.com/v1/forecast');
      u.searchParams.set('latitude', geo.latitude);
      u.searchParams.set('longitude', geo.longitude);
      u.searchParams.set('daily', 'temperature_2m_max,precipitation_sum,wind_speed_10m_max');
      u.searchParams.set('temperature_unit', 'fahrenheit');
      u.searchParams.set('precipitation_unit', 'inch');
      u.searchParams.set('wind_speed_unit', 'mph');
      u.searchParams.set('forecast_days', '14');
      u.searchParams.set('timezone', 'auto');
      const r = await fetch(u);
      const payload = r.ok ? await r.json().catch(() => null) : null;
      if (payload?.daily) {
        const d = payload.daily;
        for (let i = 0; i < (d.time || []).length; i++)
          signals.push({ profile_slug: profile.slug, kind: 'weather', for_date: d.time[i],
            place, value: { high_f: d.temperature_2m_max[i], rain_in: d.precipitation_sum[i],
                            wind_mph: d.wind_speed_10m_max[i] } });
      } else {
        signals.push({ profile_slug: profile.slug, kind: 'weather', place,
          for_date: new Date().toISOString().slice(0, 10),
          value: { note: `weather service returned ${r.status} — no forecast this run` } });
      }
    }
  }

  // Same window last year, from our own snapshots — real seasonality, not a guess.
  const from = new Date(Date.now() - 365 * 864e5 - 7 * 864e5).toISOString();
  const to = new Date(Date.now() - 365 * 864e5 + 7 * 864e5).toISOString();
  const { data: lastYear } = await db.from('ads_snapshots')
    .select('spend,results,cost_per_result')
    .eq('profile_slug', profile.slug).gte('captured_at', from).lte('captured_at', to);
  if (lastYear?.length) {
    const spend = lastYear.reduce((t, r) => t + (Number(r.spend) || 0), 0);
    const results = lastYear.reduce((t, r) => t + (Number(r.results) || 0), 0);
    signals.push({ profile_slug: profile.slug, kind: 'seasonality', for_date: new Date().toISOString().slice(0, 10),
      place, value: { window: 'same 2 weeks last year', spend, results,
                      cost_per_result: results ? spend / results : null } });
  } else {
    signals.push({ profile_slug: profile.slug, kind: 'seasonality', for_date: new Date().toISOString().slice(0, 10),
      place, value: { note: 'no history from a year ago yet — seasonality unavailable' } });
  }

  if (signals.length) await db.from('ads_market_signals').upsert(signals,
    { onConflict: 'profile_slug,kind,for_date' });
  return { signals: signals.length, place: place || null };
}
