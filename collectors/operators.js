// SOURCE 3 — what operators are saying. Fully self-contained: the engine finds the
// videos, podcasts and articles itself, stores them in its own library, and turns
// each one into specific testable claims. No other project is involved.
import { db } from '../worker/db.js';
import { extractClaims } from '../learn/ingest.js';
import { discoverVideos } from '../discovery/youtube.js';
import { discoverPodcasts } from '../discovery/podcasts.js';
import { discoverWeb } from '../discovery/web.js';


export async function pullOperators({ sinceDays = 14, discover = true } = {}) {
  const found = {};
  if (discover) {
    for (const [name, fn] of [['videos', () => discoverVideos({ sinceDays })],
                              ['podcasts', () => discoverPodcasts({ sinceDays: sinceDays + 7 })],
                              ['web', () => discoverWeb()]]) {
      try { found[name] = await fn(); } catch (e) { found[name] = { failed: String(e).slice(0, 200) }; }
    }
  }

  // Everything discovered but not yet read
  const { data: pending } = await db.from('ads_media')
    .select('id,kind,title,author,url,published_at,transcript,segment,vertical')
    .is('processed_at', null).not('transcript', 'is', null).limit(50);

  let claims = 0;
  for (const m of pending || []) {
    let n = 0;
    try {
      const out = await extractClaims(m.transcript, {
        type: m.kind, url: m.url, author: m.author, date: m.published_at?.slice(0, 10) || null,
        segment: m.segment, vertical: m.vertical
      });
      n = out.length;
    } catch (e) { console.error(`claims failed for ${m.url}:`, String(e).slice(0, 120)); }
    claims += n;
    await db.from('ads_media').update({ processed_at: new Date().toISOString(), claims_found: n })
      .eq('id', m.id);
  }
  return { discovered: found, read: pending?.length || 0, claims_filed: claims };
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await pullOperators(), null, 2));
