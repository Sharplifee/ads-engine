// GEO — what "where" means, and whether the account actually means it.
//
// Every operator story about an AI build going wrong is the same story: the ads
// ran in the wrong place. This module does three things:
//   1. turns a plain service area ("Draper, UT" + 10 miles, or a list of zips)
//      into a real platform targeting spec, using only IDs the platform returns
//   2. reads a live ad set's targeting back into the same plain shape
//   3. compares the two and says, in words, what is wrong
// Nothing here invents a location id. Unknown place, no spec — that is the point.

const V = () => process.env.META_API_VERSION;
const TOKEN = () => process.env.META_ACCESS_TOKEN;

const MILES_PER_KM = 0.621371;
export const milesToKm = mi => Math.round(mi / MILES_PER_KM);
export const kmToMiles = km => Math.round(km * MILES_PER_KM);

// ---------- 1. plain area -> platform spec ----------

export async function lookupPlace(query, { types = ['city', 'zip', 'region'], country = 'US' } = {}) {
  if (!TOKEN() || !V()) throw new Error('META_ACCESS_TOKEN / META_API_VERSION not set');
  const u = new URL(`https://graph.facebook.com/${V()}/search`);
  u.searchParams.set('type', 'adgeolocation');
  u.searchParams.set('location_types', JSON.stringify(types));
  u.searchParams.set('q', query);
  u.searchParams.set('country_code', country);
  u.searchParams.set('limit', '10');
  u.searchParams.set('access_token', TOKEN());
  const r = await fetch(u);
  const body = await r.json();
  if (!r.ok || body.error) throw new Error(`geo lookup ${r.status}: ${body.error?.message || r.statusText}`);
  return (body.data || []).filter(x => !country || x.country_code === country);
}

// Builds the targeting spec from the profile's own words. Anything it cannot
// resolve comes back in `unresolved` rather than being quietly dropped.
export async function buildGeoSpec(area = {}, { country = 'US' } = {}) {
  const spec = { location_types: area.location_types || ['home'] };
  const unresolved = [];

  if (area.zips?.length)
    spec.zips = area.zips.map(z => ({ key: `${country}:${String(z).trim()}` }));

  for (const c of area.cities || []) {
    const name = typeof c === 'string' ? c : c.name;
    const radius = typeof c === 'string' ? null : c.radius_miles;
    const [hit] = await lookupPlace(name, { types: ['city'], country });
    if (!hit) { unresolved.push(name); continue; }
    const entry = { key: hit.key, name: hit.name };
    if (radius) { entry.radius = milesToKm(radius); entry.distance_unit = 'kilometer'; }
    (spec.cities ||= []).push(entry);
  }

  for (const r of area.regions || []) {
    const [hit] = await lookupPlace(r, { types: ['region'], country });
    if (!hit) { unresolved.push(r); continue; }
    (spec.regions ||= []).push({ key: hit.key, name: hit.name });
  }

  if (area.counties?.length) {
    for (const c of area.counties) {
      const [hit] = await lookupPlace(c, { types: ['subcity', 'city'], country });
      if (!hit) { unresolved.push(c); continue; }
      (spec.cities ||= []).push({ key: hit.key, name: hit.name });
    }
  }

  const targeted = ['zips', 'cities', 'regions'].some(k => spec[k]?.length);
  if (!targeted) spec.countries = [country];        // last resort, and the audit will say so
  return { spec, unresolved, country_wide: !targeted };
}

// ---------- 2. live targeting -> plain shape ----------

export function readGeo(geo = {}) {
  const zips = (geo.zips || []).map(z => String(z.name || z.key || '').replace(/^\w+:/, ''));
  const cities = (geo.cities || []).map(c => ({
    key: String(c.key), name: c.name || String(c.key),
    radius_miles: c.radius ? (c.distance_unit === 'mile' ? c.radius : kmToMiles(c.radius)) : null
  }));
  const regions = (geo.regions || []).map(r => ({ key: String(r.key), name: r.name || String(r.key) }));
  const countries = geo.countries || [];
  const custom = (geo.custom_locations || []).map(c => ({
    lat: c.latitude, lon: c.longitude,
    radius_miles: c.radius ? (c.distance_unit === 'mile' ? c.radius : kmToMiles(c.radius)) : null
  }));
  return { zips, cities, regions, countries, custom, location_types: geo.location_types || [] };
}

// ---------- 3. intended vs live ----------

const norm = s => String(s).trim().toLowerCase();

// Pure comparison — no network, so it can be tested and reasoned about.
export function compareGeo({ intended = {}, live = {}, rules = {} } = {}) {
  const maxRadius = rules.geo_max_radius_miles ?? 30;
  const problems = [];

  const wantZips = new Set((intended.zips || []).map(z => norm(z)));
  const haveZips = new Set((live.zips || []).map(z => norm(z)));
  const wantCities = new Set((intended.cities || []).map(c => norm(typeof c === 'string' ? c : c.name)));
  const haveCities = new Set((live.cities || []).map(c => norm(c.name)));
  const wantRegions = new Set((intended.regions || []).map(norm));
  const haveRegions = new Set((live.regions || []).map(r => norm(r.name)));

  const intendedAnything = wantZips.size || wantCities.size || wantRegions.size;

  // The loudest failure: nothing local at all.
  if (live.countries?.length && !haveZips.size && !haveCities.size && !haveRegions.size)
    problems.push({ severity: 'high', kind: 'country_wide',
      message: `targeting the whole of ${live.countries.join(', ')} — no city, zip or region set` });

  if (!intendedAnything) {
    problems.push({ severity: 'medium', kind: 'no_intent',
      message: 'the profile has no service area to check this against' });
    return { problems, matched: [], extra: [], missing: [] };
  }

  const missing = [
    ...[...wantZips].filter(z => !haveZips.has(z)).map(z => `zip ${z}`),
    ...[...wantCities].filter(c => !haveCities.has(c)),
    ...[...wantRegions].filter(r => !haveRegions.has(r))
  ];
  const extra = [
    ...[...haveZips].filter(z => !wantZips.has(z)).map(z => `zip ${z}`),
    ...[...haveCities].filter(c => !wantCities.has(c)),
    ...[...haveRegions].filter(r => !wantRegions.has(r))
  ];
  const matched = [
    ...[...haveZips].filter(z => wantZips.has(z)).map(z => `zip ${z}`),
    ...[...haveCities].filter(c => wantCities.has(c)),
    ...[...haveRegions].filter(r => wantRegions.has(r))
  ];

  // Nothing in common at all: this is the wrong-state class of error.
  if (!matched.length)
    problems.push({ severity: 'high', kind: 'wrong_area',
      message: `none of the places being targeted are in the service area — running in ${
        [...haveZips, ...haveCities, ...haveRegions].slice(0, 4).join(', ') || 'nowhere recognisable'
      }, service area is ${[...wantZips, ...wantCities, ...wantRegions].slice(0, 4).join(', ')}` });
  else {
    if (extra.length) problems.push({ severity: 'medium', kind: 'outside_area',
      message: `spending outside the service area: ${extra.slice(0, 8).join(', ')}` });
    if (missing.length) problems.push({ severity: 'low', kind: 'uncovered',
      message: `service area not covered: ${missing.slice(0, 8).join(', ')}` });
  }

  for (const c of live.cities || [])
    if (c.radius_miles && c.radius_miles > maxRadius)
      problems.push({ severity: 'medium', kind: 'radius_too_wide',
        message: `${c.name} is set to ${c.radius_miles} miles, wider than the ${maxRadius}-mile cap` });

  // A lawn is at a home. Targeting people who were merely nearby buys tourists.
  const lt = (live.location_types || []).map(norm);
  if (lt.length && !lt.includes('home'))
    problems.push({ severity: 'medium', kind: 'not_residents',
      message: `targeting ${lt.join(' and ')} rather than people who live there` });
  if (rules.geo_require_home_only && lt.some(t => t !== 'home'))
    problems.push({ severity: 'low', kind: 'includes_visitors',
      message: `includes people who were only recently in the area (${lt.filter(t => t !== 'home').join(', ')})` });

  return { problems, matched, extra, missing };
}
