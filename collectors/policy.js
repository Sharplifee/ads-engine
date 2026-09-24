// SOURCE 4 — platform rules and limits.
// Stops the engine designing something the platform cannot render or will reject.
// Stored as playbook rows with category 'policy' and status 'adopted' — platform
// rules are facts, not opinions, so they skip the testing ladder.
import { db } from '../worker/db.js';
import { askJSON } from '../worker/ai.js';

const SOURCES = [
  { name: 'Ad specs', url: 'https://www.facebook.com/business/ads-guide' },
  { name: 'Advertising standards', url: 'https://transparency.meta.com/policies/ad-standards/' },
  { name: 'Lead form rules', url: 'https://www.facebook.com/business/help/1481110642181372' },
  { name: 'Marketing API changelog', url: 'https://developers.facebook.com/docs/graph-api/changelog' }
];

const strip = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export async function pullPolicy() {
  let filed = 0, failed = [];
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!res.ok) { failed.push(`${src.name} ${res.status}`); continue; }
      const text = strip(await res.text()).slice(0, 60000);
      const claims = await summarizeRules(text, src);
      for (const c of claims) {
        const { data: seen } = await db.from('ads_playbook')
          .select('id').eq('claim', c).limit(1);
        if (seen?.length) continue;
        await db.from('ads_playbook').insert({
          claim: c, category: 'policy', source_type: 'docs',
          source_url: src.url, source_author: 'Meta', status: 'adopted'
        });
        filed++;
      }
    } catch (e) { failed.push(`${src.name}: ${String(e).slice(0, 120)}`); }
  }
  return { filed, failed };
}

async function summarizeRules(text, src) {
  try {
    return await askJSON({ max_tokens: 1500, input: `${src.name}\n\n${text}`,
      system: `Extract hard platform constraints only: character limits, aspect ratios, file
size and length caps, field types a form supports, prohibited content, deprecations and
dates. One sentence each, specific and checkable. JSON array of strings. No commentary.` });
  } catch { return []; }
}
