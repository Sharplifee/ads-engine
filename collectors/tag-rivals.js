// Competitor ads arrive as raw text. Untagged they are unusable — the index groups
// by angle, hook and offer. This reads the ones that came in untagged and labels them.
import { db } from '../worker/db.js';
import { askJSON } from '../worker/ai.js';

const SYSTEM = `Label competitor ads. For each ad return:
{id, angle, hook_type, offer, promise, audience_signal}
angle: the reason to act, in 2-4 words (e.g. "same day service", "price guarantee").
hook_type: question | statistic | problem | social_proof | offer | curiosity | demo | founder.
offer: the actual deal if one is stated, else null. Never invent an offer or a price.
Return ONLY a JSON array.`;

export async function tagRivals({ limit = 60 } = {}) {
  const { data: rows } = await db.from('ads_competitor_ads')
    .select('id,advertiser,body,format').is('angle', null).not('body', 'is', null).limit(limit);
  if (!rows?.length) return { tagged: 0 };

  let tags = [];
  try {
    tags = await askJSON({ system: SYSTEM, max_tokens: 4000,
      input: rows.map(r => ({ id: r.id, advertiser: r.advertiser, format: r.format,
                              text: (r.body || '').slice(0, 900) })) });
  } catch (e) { return { tagged: 0, note: String(e).slice(0, 160) }; }

  let n = 0;
  for (const t of tags) {
    if (!t?.id) continue;
    await db.from('ads_competitor_ads')
      .update({ angle: t.angle, hook_type: t.hook_type, offer: t.offer }).eq('id', t.id);
    n++;
  }
  return { tagged: n, of: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await tagRivals(), null, 2));
