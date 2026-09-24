// Always-on monitor. Runs hourly. Reads Meta, writes snapshots, raises alerts,
// proposes actions. Only ever executes a pause, and only when the profile allows it.
import { db } from '../worker/db.js';
import { channelFor } from './channels/channel.js';
import { evaluate, stats, funnelBreak } from './rules.js';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const rules = YAML.parse(readFileSync(new URL('../engine/rules.default.yaml', import.meta.url), 'utf8'));

const num = v => (v === undefined || v === null ? null : Number(v));
function resultsOf(row, primary) {
  const map = { lead: ['lead', 'onsite_conversion.lead_grouped', 'leadgen.other'],
                purchase: ['purchase', 'omni_purchase'],
                appointment: ['schedule', 'onsite_conversion.schedule'],
                install: ['mobile_app_install', 'omni_app_install'] };
  const want = map[primary] || [primary];
  const hit = (row.actions || []).filter(a => want.includes(a.action_type));
  return hit.reduce((s, a) => s + Number(a.value || 0), 0) || 0;
}

export async function runProfile(profile) {
  const { pullLevel, pullEntities, pauseEntity } = await channelFor(profile);
  const acct = profile.ad_account_id;
  const captured = new Date().toISOString();
  const levels = ['campaign', 'adset', 'ad'];
  const entityMeta = Object.fromEntries(
    (await pullEntities(acct, 'ads')).map(e => [e.id, e]));

  // Winner windows need the same ads judged over 3, 7 and 14 days
  const windowRows = {};
  for (const [key, preset] of [['w3', 'last_3d'], ['w7', 'last_7d'], ['w14', 'last_14d']]) {
    for (const r of await pullLevel(acct, 'ad', preset)) {
      const res = resultsOf(r, profile.primary_result);
      (windowRows[r.ad_id] ||= {})[key] = { cost_per_result: res ? Number(r.spend) / res : Infinity };
    }
  }

  for (const level of levels) {
    const rows = await pullLevel(acct, level, 'last_7d');
    const campaignSpend = {};
    for (const r of rows) campaignSpend[r.campaign_id] = (campaignSpend[r.campaign_id] || 0) + (Number(r.spend) || 0);
    const snapshots = rows.map(r => {
      const results = resultsOf(r, profile.primary_result);
      const spend = num(r.spend) || 0;
      return {
        profile_slug: profile.slug, captured_at: captured, level,
        entity_id: r[`${level}_id`] || r.ad_id || r.adset_id || r.campaign_id,
        parent_id: level === 'ad' ? r.adset_id : level === 'adset' ? r.campaign_id : null,
        name: r[`${level}_name`] || null,
        status: entityMeta[r.ad_id]?.effective_status || null,
        spend, impressions: num(r.impressions), clicks: num(r.clicks),
        ctr: num(r.ctr), cpm: num(r.cpm), frequency: num(r.frequency),
        results, cost_per_result: results ? spend / results : null,
        link_clicks: num(r.inline_link_clicks),
        landing_page_views: (r.actions || []).filter(a => a.action_type === 'landing_page_view')
          .reduce((t, a) => t + Number(a.value || 0), 0),
        raw: r
      };
    });
    if (snapshots.length) await db.from('ads_snapshots').insert(snapshots);

    // Baselines from this account's own trailing history
    const { data: hist } = await db.from('ads_snapshots')
      .select('entity_id,ctr,cpm,cost_per_result,spend,captured_at')
      .eq('profile_slug', profile.slug).eq('level', level)
      .gte('captured_at', new Date(Date.now() - 21 * 864e5).toISOString());

    for (const s of snapshots) {
      const h = (hist || []).filter(x => x.entity_id === s.entity_id);
      const baselines = {
        ctr: stats(h.map(x => x.ctr)), cpm: stats(h.map(x => x.cpm)),
        spend: stats(h.map(x => x.spend)), cost_per_result: stats(h.map(x => x.cost_per_result))
      };
      const { alerts, actions } = evaluate({
        entity: { ...s, created_time: entityMeta[s.entity_id]?.created_time,
          windows: level === 'ad' ? windowRows[s.entity_id] : undefined,
          share_of_parent_spend: level === 'ad' && campaignSpend[s.raw.campaign_id]
            ? s.spend / campaignSpend[s.raw.campaign_id] : 0 },
        history: h, baselines, profile, rules
      });
      const fb = funnelBreak(s, baselines);
      // Same problem, same ad, every hour, forever is noise — and noise gets ignored.
      // One alert per rule per entity per cooldown window; the evidence keeps updating.
      const cooldownHours = rules.guardrails.alert_cooldown_hours ?? 12;
      const cutoff = new Date(Date.now() - cooldownHours * 36e5).toISOString();
      for (const a of alerts) {
        const { data: recent } = await db.from('ads_alerts').select('id')
          .eq('profile_slug', profile.slug).eq('rule_id', a.rule_id)
          .eq('entity_id', s.entity_id).gte('raised_at', cutoff).limit(1);
        if (recent?.length) {
          await db.from('ads_alerts').update({ evidence: { snapshot: s, funnel_break: fb } })
            .eq('id', recent[0].id);
          continue;
        }
        await db.from('ads_alerts').insert({
          profile_slug: profile.slug, rule_id: a.rule_id, severity: a.severity,
          level, entity_id: s.entity_id, entity_name: s.name,
          message: a.message, evidence: { snapshot: s, funnel_break: fb }
        });
      }

      for (const act of actions) {
        const { data: openSame } = await db.from('ads_actions').select('id')
          .eq('profile_slug', profile.slug).eq('entity_id', s.entity_id)
          .eq('action_type', act.action_type).in('state', ['proposed', 'approved']).limit(1);
        if (openSame?.length) continue;          // one open proposal per thing at a time
        const auto = act.action_type === 'pause' && profile.autonomy?.auto_pause;
        const { data: rec } = await db.from('ads_actions').insert({
          profile_slug: profile.slug, rule_id: act.rule_id, action_type: act.action_type,
          level, entity_id: s.entity_id, entity_name: s.name,
          payload: act.payload || {}, state: auto ? 'approved' : 'proposed'
        }).select().single();

        if (auto) {
          try {
            await pauseEntity(s.entity_id);
            await db.from('ads_actions').update({ state: 'executed', executed_at: new Date().toISOString() }).eq('id', rec.id);
            await db.from('ads_audit').insert({ profile_slug: profile.slug, actor: 'engine',
              what: `paused ${s.name || s.entity_id}`, before_state: { status: s.status },
              after_state: { status: 'PAUSED' }, reason: act.message || act.rule_id });
          } catch (e) {
            await db.from('ads_actions').update({ state: 'proposed', result: { error: String(e) } }).eq('id', rec.id);
            await db.from('ads_audit').insert({ profile_slug: profile.slug, actor: 'engine',
              what: `pause FAILED on ${s.name || s.entity_id}`, reason: String(e).slice(0, 400) });
          }
        }
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { data: profiles } = await db.from('ads_profiles').select('*');
  for (const p of profiles || []) {
    const profile = { ...p, ...p.config, autonomy: p.autonomy, primary_result: p.primary_result };
    try { await runProfile(profile); console.log('ok', p.slug); }
    catch (e) { console.error('FAILED', p.slug, String(e)); }
  }
}
