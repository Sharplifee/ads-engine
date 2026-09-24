// THE MISSING HAND — approved actions were being written and never applied.
// This takes actions a human approved and carries them out, with every guardrail
// checked at the moment of execution, not just when the action was proposed.
import { db } from '../worker/db.js';
import { channelFor } from './channels/channel.js';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
const rules = YAML.parse(readFileSync(new URL('../engine/rules.default.yaml', import.meta.url), 'utf8'));

async function guardsPass(profile, action) {
  const day = new Date(Date.now() - 864e5).toISOString();
  const { data: recent } = await db.from('ads_audit')
    .select('id').eq('profile_slug', profile.slug).gte('at', day)
    .ilike('what', `%${action.entity_id}%`);
  const cap = profile.autonomy?.max_changes_per_entity_per_day ?? 1;
  if ((recent?.length || 0) >= cap)
    return `already changed ${recent.length} time(s) in 24h — cap is ${cap}`;

  if (action.action_type === 'budget_change') {
    const step = action.payload?.step_pct ?? 0;
    const max = profile.rules?.max_budget_step_pct ?? rules.guardrails.max_budget_step_pct;
    if (step > max) return `step ${step}% exceeds the ${max}% cap`;
    const ceiling = profile.goal?.daily_spend_ceiling;
    if (ceiling && action.payload?.new_daily_budget > ceiling)
      return `would push daily budget past the $${ceiling} ceiling`;
  }
  return null;
}

export async function executeApproved({ limit = 25 } = {}) {
  const { data: queue } = await db.from('ads_actions')
    .select('*').eq('state', 'approved').limit(limit);
  if (!queue?.length) return { executed: 0 };

  const report = { executed: 0, blocked: 0, failed: 0, details: [] };
  for (const a of queue) {
    const { data: row } = await db.from('ads_profiles').select('*').eq('slug', a.profile_slug).single();
    const profile = { ...row, ...row.config };
    const ch = await channelFor(profile);

    const blocked = await guardsPass(profile, a);
    if (blocked) {
      await db.from('ads_actions').update({ state: 'proposed', result: { blocked } }).eq('id', a.id);
      await db.from('ads_audit').insert({ profile_slug: profile.slug, actor: 'engine',
        what: `blocked ${a.action_type} on ${a.entity_name || a.entity_id}`, reason: blocked });
      report.blocked++; report.details.push({ id: a.id, blocked });
      continue;
    }

    try {
      let before = null, after = null;
      if (a.action_type === 'pause') {
        before = await ch.getEntity(a.entity_id).catch(() => null);
        await ch.pauseEntity(a.entity_id);
        after = { status: 'PAUSED' };
      } else if (a.action_type === 'budget_change') {
        const cur = await ch.getEntity(a.entity_id);
        const currentMinor = Number(cur.daily_budget || 0);
        if (!currentMinor) throw new Error('no daily budget on this entity — set it at the right level');
        const next = Math.round(currentMinor * (1 + (a.payload?.step_pct ?? 0) / 100));
        before = { daily_budget: currentMinor };
        await ch.setBudget(a.entity_id, next);
        after = { daily_budget: next };
      } else if (a.action_type === 'create') {
        const made = await ch.createDraft({ accountId: profile.ad_account_id,
          level: a.level, payload: a.payload });
        after = { created: made.id, status: 'PAUSED' };
      } else {
        throw new Error(`no executor for action type "${a.action_type}"`);
      }

      await db.from('ads_actions').update({ state: 'executed',
        executed_at: new Date().toISOString(), result: { before, after } }).eq('id', a.id);
      await db.from('ads_audit').insert({ profile_slug: profile.slug,
        actor: a.approved_by || 'human-approved', what: `${a.action_type} on ${a.entity_name || a.entity_id}`,
        before_state: before, after_state: after, reason: a.rule_id });
      report.executed++;
    } catch (e) {
      await db.from('ads_actions').update({ state: 'approved', result: { error: String(e) } }).eq('id', a.id);
      await db.from('ads_audit').insert({ profile_slug: a.profile_slug, actor: 'engine',
        what: `${a.action_type} FAILED on ${a.entity_name || a.entity_id}`, reason: String(e).slice(0, 400) });
      report.failed++; report.details.push({ id: a.id, error: String(e).slice(0, 200) });
    }
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await executeApproved(), null, 2));
