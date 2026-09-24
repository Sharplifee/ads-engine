// DISCOVERY — the open web, for anything the other lanes miss. Firecrawl search.
import { db } from '../worker/db.js';
import { currentQueries } from './queries.js';
const KEY = process.env.FIRECRAWL_API_KEY;

export async function discoverWeb({ perQuery = 5 } = {}) {
  if (!KEY) return { skipped: 'FIRECRAWL_API_KEY missing' };
  const rows = [];
  for (const { q, segment, vertical } of currentQueries()) {
    try {
      const r = await fetch('https://api.firecrawl.dev/v2/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ query: q, limit: perQuery, tbs: 'qdr:m',
                               scrapeOptions: { formats: ['markdown'] } })
      });
      if (!r.ok) { console.error(`firecrawl ${r.status} on "${q}"`); continue; }
      const j = await r.json();
      for (const item of (j.data?.web || j.data || [])) {
        const text = item.markdown || item.description || '';
        if (!text) continue;
        rows.push({ kind: 'article', external_id: (item.url || '').slice(0, 200),
          title: item.title || item.url, author: new URL(item.url).hostname,
          url: item.url, published_at: null, found_via: `query:${q}`, segment, vertical,
          transcript: text.slice(0, 60000), words: text.split(/\s+/).length });
      }
    } catch (e) { console.error(`web query "${q}" failed:`, String(e).slice(0, 120)); }
  }
  if (rows.length) await db.from('ads_media').upsert(rows, { onConflict: 'kind,external_id' });
  return { stored: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await discoverWeb(), null, 2));
