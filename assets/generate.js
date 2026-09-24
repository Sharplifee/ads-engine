// ASSET PRODUCTION — turns an approved creative brief into a real image file and
// hosts it at a public URL, because Meta will only accept creative it can fetch.
// Hard rule from the doctrine: nothing generated may misrepresent the actual product
// or work. Backgrounds, type and abstract scenes only — never a fake finished job.
import { db } from '../worker/db.js';

const FORBIDDEN = /before and after|finished (lawn|yard|job|install)|our work|real customer|actual (result|home)/i;

export async function generateFromBrief(briefId, { size = '1024x1024' } = {}) {
  const { data: brief } = await db.from('ads_creative_briefs').select('*').eq('id', briefId).single();
  if (!brief) throw new Error(`no brief ${briefId}`);
  const { data: prof } = await db.from('ads_profiles').select('*').eq('slug', brief.profile_slug).single();
  const profile = { ...prof, ...prof.config };

  if (profile.creative?.ai_imagery_of_product_allowed === false && FORBIDDEN.test(brief.asset_spec || ''))
    return { refused: 'this brief asks for imagery of the actual work — shoot it, do not generate it',
             brief_id: briefId };
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

  const colors = (profile.brand?.colors || []).slice(0, 3).join(', ');
  const prompt = [
    `Advertising background graphic. Angle: ${brief.angle}. Hook: ${brief.hook || ''}.`,
    colors ? `Brand colours: ${colors}.` : '',
    'Clean, uncluttered, high contrast, room for text overlay in the upper third.',
    'No text, no logos, no people, no depiction of a finished job or product result.',
    brief.asset_spec ? `Art direction: ${brief.asset_spec}` : ''
  ].filter(Boolean).join(' ');

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: process.env.IMAGE_MODEL || 'gpt-image-1-mini', prompt, size, n: 1 })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Image API ${res.status}: ${body.error?.message || res.statusText}`);
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error('image API returned no image');

  // Public URL is required by the ad platform — Supabase storage gives us one.
  const bucket = process.env.ASSET_BUCKET || 'ad-assets';
  const path = `${brief.profile_slug}/${briefId}-${Date.now()}.png`;
  const bytes = Buffer.from(b64, 'base64');
  const up = await db.storage.from(bucket).upload(path, bytes, { contentType: 'image/png', upsert: true });
  if (up.error) throw new Error(`upload failed: ${up.error.message}`);
  const { data: pub } = db.storage.from(bucket).getPublicUrl(path);

  await db.from('ads_creative_briefs').update({
    copy: { ...(brief.copy || {}), asset_url: pub.publicUrl }, state: 'built'
  }).eq('id', briefId);

  return { brief_id: briefId, url: pub.publicUrl, prompt_used: prompt.slice(0, 140) };
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await generateFromBrief(Number(process.argv[2])), null, 2));
