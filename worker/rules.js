// Rules engine. Pure functions over snapshots — no network, testable.
export function stats(values) {
  const v = values.filter(n => Number.isFinite(n));
  if (!v.length) return { mean: null, sd: null, n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd, n: v.length };
}

export function evaluate({ entity, history, baselines, profile, rules }) {
  const alerts = [], actions = [];
  const target = profile.goal?.target_cost_per_result ?? baselines?.cost_per_result?.mean;
  const g = rules.guardrails;
  const ageHours = entity.created_time ? (Date.now() - new Date(entity.created_time)) / 36e5 : Infinity;
  const tooYoung = ageHours < g.never_touch_entities_younger_than_hours;

  // KILL — spend with nothing to show
  if (target && entity.spend >= 3 * target && (entity.results || 0) === 0) {
    const a = { rule_id: 'spend_no_result', severity: 'high',
      message: `${entity.name} spent $${entity.spend.toFixed(2)} with zero results (3x target cost).` };
    alerts.push(a);
    if (profile.autonomy?.auto_pause && !tooYoung)
      actions.push({ ...a, action_type: 'pause', entity_id: entity.entity_id });
  }

  // KILL — cost blowout with enough data to be real
  if (target && (entity.results || 0) >= 3 && entity.cost_per_result > 2 * target) {
    const a = { rule_id: 'cost_blowout', severity: 'high',
      message: `${entity.name} at $${entity.cost_per_result.toFixed(2)} per result vs $${target.toFixed(2)} target.` };
    alerts.push(a);
    if (profile.autonomy?.auto_pause && !tooYoung)
      actions.push({ ...a, action_type: 'pause', entity_id: entity.entity_id });
  }

  // DELIVERY — active but invisible
  if (entity.status === 'ACTIVE' && (entity.impressions || 0) === 0 && ageHours > 24)
    alerts.push({ rule_id: 'dead_delivery', severity: 'medium',
      message: `${entity.name} is active but got no impressions in 24 hours.` });

  // FATIGUE — worn out, not just expensive
  // CTR by calendar week over the last 21 days, oldest to newest
  const weeks = [0, 1, 2].map(w => {
    const end = Date.now() - w * 7 * 864e5, start = end - 7 * 864e5;
    const rows = history.filter(h => { const t = new Date(h.captured_at).getTime(); return t >= start && t < end; });
    return stats(rows.map(h => h.ctr)).mean;
  }).reverse();
  const declining = weeks.every(Number.isFinite) && weeks[0] > weeks[1] && weeks[1] > weeks[2];
  if ((entity.frequency || 0) > 2.5 && declining)
    actions.push({ rule_id: 'frequency_decay', severity: 'medium', action_type: 'refresh',
      entity_id: entity.entity_id,
      message: `${entity.name} frequency ${entity.frequency.toFixed(2)} with CTR falling two weeks running — refresh it.` });

  // ANOMALY — both directions, against the account's own history
  for (const metric of ['spend', 'cpm', 'ctr', 'cost_per_result']) {
    const b = baselines?.[metric];
    const val = entity[metric];
    if (!b?.sd || !Number.isFinite(val)) continue;
    const z = (val - b.mean) / b.sd;
    if (Math.abs(z) > 2)
      alerts.push({ rule_id: 'two_sigma_move', severity: z < 0 && metric === 'cost_per_result' ? 'good' : 'medium',
        message: `${entity.name}: ${metric} at ${val.toFixed(2)} is ${z.toFixed(1)} standard deviations from its own normal.` });
  }

  // WINNER — must hold across windows, must be taking real spend
  if (target && entity.share_of_parent_spend > 0.05 && entity.cost_per_result && entity.cost_per_result < target) {
    const holds = ['w3', 'w7', 'w14'].filter(w => entity.windows?.[w]?.cost_per_result < target).length;
    if (holds >= 2) {
      alerts.push({ rule_id: 'proven_winner', severity: 'good',
        message: `${entity.name} is a winner: $${entity.cost_per_result.toFixed(2)} per result on ${(entity.share_of_parent_spend * 100).toFixed(0)}% of spend.` });
      if (!tooYoung)
        actions.push({ rule_id: 'proven_winner', action_type: 'budget_change', entity_id: entity.entity_id,
          payload: { step_pct: Math.min(20, rules.guardrails.max_budget_step_pct) },
          message: `Scale ${entity.name} by up to 20%.`, severity: 'good' });
    }
  }
  return { alerts, actions };
}

// Which stage of the funnel broke — first failing stage wins.
export function funnelBreak(entity, baselines) {
  const b = baselines || {};
  if (b.ctr?.mean && entity.ctr < 0.5 * b.ctr.mean)
    return { stage: 'attention', verdict: "Creative isn't earning the click — hook problem." };
  if (entity.link_clicks && entity.landing_page_views < 0.7 * entity.link_clicks)
    return { stage: 'click_to_land', verdict: 'Clicks are not landing — page speed or broken link.' };
  if (entity.landing_page_views && (entity.results || 0) < 0.02 * entity.landing_page_views)
    return { stage: 'landing_to_action', verdict: 'The page or form is the problem, not the ad.' };
  if (b.cpm?.mean && entity.cpm > 1.5 * b.cpm.mean)
    return { stage: 'cost', verdict: 'Auction cost — audience too narrow or overlapping itself.' };
  return { stage: 'none', verdict: 'No structural break detected.' };
}
