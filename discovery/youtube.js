// DISCOVERY — finds new videos itself. No dependency on any other project.
// Two ways in: a floor of known operators, and — the part that matters — a rotating
// slice of the whole coverage map, so it keeps finding people and formats nobody
// told it about. Transcripts come from Supadata, with an Apify actor as fallback.
import { db } from '../worker/db.js';
import { currentQueries, operators } from './queries.js';

const YT = process.env.YOUTUBE_API_KEY;
const SUPADATA = process.env.SUPADATA_API_KEY;
const APIFY = process.env.APIFY_TOKEN;

async function yt(path, params) {
  if (!YT) throw new Error('YOUTUBE_API_KEY missing');
  const u = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', YT);
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok) throw new Error(`YouTube ${r.status}: ${j.error?.message || 'unknown'}`);
  return j;
}

// A handle or channel name -> the channel's uploads playlist.
async function uploadsPlaylist(nameOrHandle) {
  const q = String(nameOrHandle).replace(/^@/, '');
  const found = await yt('search', { part: 'snippet', q, type: 'channel', maxResults: 1 });
  const id = found.items?.[0]?.snippet?.channelId;
  if (!id) return null;
  const ch = await yt('channels', { part: 'contentDetails,snippet', id });
  return { playlist: ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads,
           title: ch.items?.[0]?.snippet?.title, channelId: id };
}

export async function discoverVideos({ sinceDays = 14, perQuery = 15 } = {}) {
  const publishedAfter = new Date(Date.now() - sinceDays * 864e5).toISOString();
  const candidates = new Map();

  // 1. People we follow, newest uploads
  for (const name of operators()) {
    try {
      const ch = await uploadsPlaylist(name);
      if (!ch?.playlist) continue;
      const items = await yt('playlistItems',
        { part: 'snippet,contentDetails', playlistId: ch.playlist, maxResults: 20 });
      for (const it of items.items || []) {
        const pub = it.contentDetails?.videoPublishedAt;
        if (!pub || pub < publishedAfter) continue;
        candidates.set(it.contentDetails.videoId, {
          external_id: it.contentDetails.videoId, title: it.snippet.title,
          author: ch.title || name, published_at: pub, found_via: `channel:${name}`
        });
      }
    } catch (e) { console.error(`channel "${name}" failed:`, String(e).slice(0, 120)); }
  }

  // 2. Open market search — today's rotating slice of the coverage map.
  // This is the part that finds operators and formats nobody told us about.
  for (const { q, segment, vertical } of currentQueries()) {
    try {
      const found = await yt('search', { part: 'snippet', q, type: 'video', order: 'date',
        publishedAfter, maxResults: perQuery, relevanceLanguage: 'en' });
      for (const it of found.items || [])
        candidates.set(it.id.videoId, {
          external_id: it.id.videoId, title: it.snippet.title,
          author: it.snippet.channelTitle, published_at: it.snippet.publishedAt,
          found_via: `query:${q}`, segment, vertical });
    } catch (e) { console.error(`query "${q}" failed:`, String(e).slice(0, 120)); }
  }

  // Skip anything already in the library
  const ids = [...candidates.keys()];
  const { data: known } = await db.from('ads_media')
    .select('external_id').eq('kind', 'youtube').in('external_id', ids);
  for (const k of known || []) candidates.delete(k.external_id);

  const rows = [];
  for (const c of candidates.values()) {
    const transcript = await transcriptFor(c.external_id);
    rows.push({ kind: 'youtube', external_id: c.external_id, title: c.title, author: c.author,
      url: `https://www.youtube.com/watch?v=${c.external_id}`, published_at: c.published_at,
      found_via: c.found_via, segment: c.segment || null, vertical: c.vertical || null,
      transcript, words: transcript ? transcript.split(/\s+/).length : 0 });
  }
  if (rows.length) await db.from('ads_media').upsert(rows, { onConflict: 'kind,external_id' });
  return { found: candidates.size, stored: rows.length,
           with_transcript: rows.filter(r => r.transcript).length };
}

export async function transcriptFor(videoId) {
  if (SUPADATA) {
    try {
      const r = await fetch(`https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true`,
        { headers: { 'x-api-key': SUPADATA } });
      if (r.ok) { const j = await r.json(); if (j.content) return typeof j.content === 'string'
        ? j.content : j.content.map(c => c.text).join(' '); }
    } catch {}
  }
  if (APIFY) {
    try {
      const actor = process.env.APIFY_YT_TRANSCRIPT_ACTOR || 'pintostudio~youtube-transcript-scraper';
      const r = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${APIFY}`,
        { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ videoUrl: `https://www.youtube.com/watch?v=${videoId}` }) });
      if (r.ok) {
        const items = await r.json();
        const text = items.map(i => i.text || i.transcript || '').join(' ').trim();
        if (text) return text;
      }
    } catch {}
  }
  return null;   // honest null — the claim extractor simply skips it
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await discoverVideos({ sinceDays: Number(process.argv[2]) || 14 }), null, 2));
