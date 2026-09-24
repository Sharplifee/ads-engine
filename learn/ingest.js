// Self-updating playbook. Turns anything the engine discovered — video, podcast or
// article — into specific testable claims, tagged by how the money is made so the
// index can tell subscription advice apart from one-time-sale advice.
// Nothing here ever touches an ad account. A claim becomes doctrine only after
// it is tested on a profile and wins.
import { db } from '../worker/db.js';


const EXTRACT = `You are reading a transcript from someone who runs Meta ads for a living.
Pull out ONLY specific, testable claims: a setting, a threshold, a number, a structure, a
sequence, or a platform behaviour. Ignore hype, self-promotion, and generic advice.
Return JSON array, each item: {claim, category, segment, vertical, format, confidence, quote_context}.
category: setting | threshold | structure | creative | policy.
segment: subscription | one_time_sale | lead_gen | appointment | high_ticket | app_install | null.
vertical and format: only if the speaker names them, otherwise null.
If the transcript contains nothing specific, return [].`;

export async function extractClaims(transcript, source) {
  let items = [];
  try { items = await askJSON({ system: EXTRACT, max_tokens: 2000,
                                input: transcript.slice(0, 120000) }); }
  catch { return []; }

  for (const it of items) {
    // Corroboration beats novelty: if someone already said it, raise its weight.
    const { data: existing } = await db.from('ads_playbook')
      .select('id,corroborations').ilike('claim', `%${it.claim.slice(0, 40)}%`).limit(1);
    if (existing?.length) {
      await db.from('ads_playbook')
        .update({ corroborations: existing[0].corroborations + 1 }).eq('id', existing[0].id);
    } else {
      await db.from('ads_playbook').insert({
        claim: it.claim, category: it.category,
        segment: it.segment || source.segment || null,
        vertical: it.vertical || source.vertical || null,
        source_type: source.type,
        source_url: source.url, source_author: source.author, source_date: source.date,
        status: 'candidate', notes: it.quote_context
      });
    }
  }
  return items;
}
