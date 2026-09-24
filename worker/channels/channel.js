// Every ad platform we support implements this same shape, so nothing above this
// layer knows or cares which platform it is talking to.
//   pullEntities(accountId)          -> [{id, level, parent_id, name, status, created_time, budget}]
//   pullInsights(accountId, level, window) -> [{entity_id, spend, impressions, clicks, ctr, cpm,
//                                               frequency, results, landing_page_views, link_clicks}]
//   pause(entityId)                  -> {ok}
//   setBudget(entityId, amountMinor)  -> {ok}   // minor units (cents), never dollars
//   getEntity(entityId, fields)       -> current state, read before every write
//   createDraft(spec)                -> {ok, ids}   // must land paused
//   searchLibrary(query)             -> [{advertiser, body, format, first_seen, days_running}]
// A channel that cannot do one of these exports it as unsupported() so the engine
// degrades honestly instead of pretending.
export function unsupported(name) {
  return async () => { throw new Error(`${name} is not supported on this channel`); };
}
export const CHANNELS = { meta: () => import('./meta.js') };
export async function channelFor(profile) {
  const load = CHANNELS[profile.channel || 'meta'];
  if (!load) throw new Error(`No channel adapter for "${profile.channel}"`);
  return load();
}
