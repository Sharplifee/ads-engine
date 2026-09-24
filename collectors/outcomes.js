// SOURCE 6 — what leads actually closed.
// The platform only knows a form was filled in. This pulls what happened after,
// and ties it back to the ad that produced it. Without this, "cost per lead" is
// the wrong number to optimize toward.
import { db } from '../worker/db.js';

const ADAPTERS = {
  // The CRM lives in a table in this same database.
  supabase: async (profile) => {
    const c = profile.downstream?.crm_config || {};
    if (!c.table) throw new Error('downstream.crm_config.table not set');
    const { data, error } = await db.from(c.table).select('*')
      .gte(c.created_field || 'created_at', new Date(Date.now() - 90 * 864e5).toISOString());
    if (error) throw new Error(`CRM read failed: ${error.message}`);
    return (data || []).map(r => ({
      external_id: String(r[c.id_field || 'id']),
      created_at: r[c.created_field || 'created_at'],
      stage: r[c.stage_field || 'stage'],
      won: c.won_values ? c.won_values.includes(r[c.stage_field || 'stage']) : null,
      value: c.value_field ? Number(r[c.value_field]) : null,
      source_ad: r[c.ad_field || 'ad_id'] || null,
      raw: r
    }));
  },
  // Anything that can POST rows into ads_outcomes itself (Zapier, Make, a webhook).
  webhook: async () => [],
  none: async () => []
};

export async function pullOutcomes(profile) {
  const kind = profile.downstream?.crm || 'none';
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new Error(`No CRM adapter for "${kind}"`);
  const rows = await adapter(profile);
  if (!rows.length) return { pulled: 0, note: kind === 'none' ? 'no CRM connected for this profile' : 'no rows' };

  await db.from('ads_outcomes').upsert(rows.map(r => ({
    profile_slug: profile.slug, external_id: r.external_id, created_at: r.created_at,
    stage: r.stage, won: r.won, value: r.value, entity_id: r.source_ad, raw: r.raw
  })), { onConflict: 'profile_slug,external_id' });

  // True cost per closed job, per ad — the number that actually matters.
  const { data: joined } = await db.rpc('ads_true_cost_per_win', { p_slug: profile.slug })
    .then(r => r, () => ({ data: null }));
  return { pulled: rows.length, true_cost_available: Boolean(joined) };
}
