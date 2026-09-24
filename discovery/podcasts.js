// DISCOVERY — podcasts. iTunes search needs no key; every show exposes an RSS feed.
// Episode notes alone are often enough to catch a claim worth testing.
import { db } from '../worker/db.js';
import { currentQueries } from './queries.js';

const tag = (xml, name) => [...xml.matchAll(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'gi'))]
  .map(m => m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());

export async function discoverPodcasts({ sinceDays = 21 } = {}) {
  const since = Date.now() - sinceDays * 864e5;
  const rows = [];
  for (const { q, segment, vertical } of currentQueries()) {
    try {
      const s = await fetch(`https://itunes.apple.com/search?media=podcast&limit=3&term=${encodeURIComponent(q)}`);
      if (!s.ok) continue;
      const shows = (await s.json()).results || [];
      for (const show of shows) {
        if (!show.feedUrl) continue;
        const f = await fetch(show.feedUrl, { headers: { 'user-agent': 'Mozilla/5.0' } });
        if (!f.ok) continue;
        const xml = await f.text();
        const items = xml.split(/<item[\s>]/).slice(1, 15);
        for (const it of items) {
          const title = tag(it, 'title')[0] || '';
          const pub = tag(it, 'pubDate')[0];
          const link = tag(it, 'link')[0] || show.trackViewUrl;
          const notes = (tag(it, 'description')[0] || '').replace(/<[^>]+>/g, ' ').slice(0, 8000);
          if (!pub || new Date(pub).getTime() < since) continue;
          rows.push({ kind: 'podcast', external_id: `${show.collectionId}:${title}`.slice(0, 200),
            title, author: show.collectionName, url: link,
            published_at: new Date(pub).toISOString(), found_via: `query:${q}`, segment, vertical,
            transcript: notes, words: notes.split(/\s+/).length });
        }
      }
    } catch (e) { console.error(`podcast query "${q}" failed:`, String(e).slice(0, 120)); }
  }
  if (rows.length) await db.from('ads_media').upsert(rows, { onConflict: 'kind,external_id' });
  return { stored: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await discoverPodcasts(), null, 2));
