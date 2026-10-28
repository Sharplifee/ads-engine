// Append-only event log client for the ads-engine workers (Corpus HQ public.event_log).
//
// One side-effect import at the top of any entry script:
//     import './eventlog.js';            (or '../worker/eventlog.js')
//
// What it records, with no further code changes:
//   * job_start when the script starts, job_end at exit (status=fail on an uncaught error)
//   * every outbound HTTP call made through global fetch (host/path, status, duration,
//     attempt — repeat calls to the same URL inside one run are numbered, so retries show
//     up as `retry` rather than `fetch`). supabase-js uses global fetch, so DB calls are
//     covered too.
//   * uncaught exceptions and unhandled rejections as `error` rows
// Optional explicit calls: eventlog.step('name', {...}), eventlog.error(err, 'name', {...}).
//
// Credentials are read lazily from SUPABASE_URL / SUPABASE_SERVICE_KEY at flush time, so
// importing this file never requires configuration. The table is append-only at the DB
// level (UPDATE/DELETE/TRUNCATE blocked), so a run's record can never be edited later.
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const PROJECT = process.env.EVENT_LOG_PROJECT || 'ads-engine';
const RUN = process.env.GITHUB_RUN_ID || null;
const BUILD = (process.env.GITHUB_SHA || '').slice(0, 12) || null;
const ENV = process.env.GITHUB_ACTIONS ? 'production' : 'development';
const realFetch = globalThis.fetch.bind(globalThis);

const job = { name: `ads.${basename(process.argv[1] || 'worker').replace(/\.js$/, '')}`, trace_id: randomUUID().replace(/-/g, ''), started: Date.now(), steps: 0, failed: false };
const attempts = new Map();
let queue = [];
let flushing = null;

function endpoint() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  return url && key ? { url: `${url}/rest/v1/rpc/log_events`, key } : null;
}

function bounded(p) {
  try { const s = JSON.stringify(p ?? {}); return s.length <= 8000 ? JSON.parse(s) : { truncated: true, bytes: s.length, head: s.slice(0, 7000) }; }
  catch { return { unserializable: true }; }
}

export function log(event_type, name, status, extra = {}) {
  const { payload, ...rest } = extra;
  queue.push({
    project: PROJECT, surface: 'worker', env: ENV, event_type, name: String(name).slice(0, 300), status,
    actor_type: process.env.GITHUB_ACTIONS ? 'cron' : 'service',
    actor_id: RUN ? `github-actions:${process.env.GITHUB_WORKFLOW || ''}:${RUN}` : `local:${process.env.USER || 'worker'}`,
    trace_id: job.trace_id, session_id: RUN, build: BUILD, client_ts: new Date().toISOString(),
    ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null)),
    error_message: rest.error_message ? String(rest.error_message).slice(0, 4000) : undefined,
    payload: bounded(payload),
  });
  if (queue.length >= 25) void flush();
}

export async function flush() {
  if (flushing) return flushing;
  const ep = endpoint();
  if (!ep) { queue = []; return; }
  const batch = queue.splice(0, queue.length);
  if (!batch.length) return;
  flushing = realFetch(ep.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ep.key, Authorization: `Bearer ${ep.key}`, Prefer: 'return=minimal' },
    body: JSON.stringify({ p: batch }),
  }).then(async (r) => { if (!r.ok) process.stderr.write(`[event_log] write failed ${r.status}: ${(await r.text()).slice(0, 200)}\n`); })
    .catch((e) => process.stderr.write(`[event_log] write threw: ${e?.message ?? e}\n`))
    .finally(() => { flushing = null; });
  return flushing;
}

export function step(name, payload = {}, status = 'ok') {
  job.steps += 1;
  log('job_step', `${job.name}.${name}`, status, { attempt: job.steps, payload });
}

export function error(err, name, payload = {}) {
  log('error', name || `${job.name}.error`, 'fail', { error_code: err?.name || 'Error', error_message: err?.message ?? String(err), payload });
}

// ---- global fetch hook -----------------------------------------------------
globalThis.fetch = async function loggedFetch(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url ?? String(input);
  if (url.includes('/rest/v1/rpc/log_events')) return realFetch(input, init);
  const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
  let host = url, path = '';
  try { const u = new URL(url); host = u.host; path = u.pathname.slice(0, 300); } catch { /* keep raw */ }
  const key = `${method} ${host}${path}`;
  const attempt = (attempts.get(key) || 0) + 1; attempts.set(key, attempt);
  const started = Date.now();
  try {
    const res = await realFetch(input, init);
    log(attempt > 1 ? 'retry' : 'fetch', `${method} ${host}${path}`, res.ok ? 'ok' : 'fail',
      { http_method: method, http_path: `${host}${path}`, http_status: res.status, attempt, duration_ms: Date.now() - started });
    return res;
  } catch (e) {
    log('error', `${method} ${host}${path}`, 'fail',
      { http_method: method, http_path: `${host}${path}`, attempt, duration_ms: Date.now() - started, error_code: e?.name || 'FetchError', error_message: e?.message ?? String(e) });
    throw e;
  }
};

// ---- lifecycle ---------------------------------------------------------------
process.on('uncaughtExceptionMonitor', (e) => { job.failed = true; log('error', `${job.name}.uncaught`, 'fail', { error_code: e?.name || 'Error', error_message: e?.message ?? String(e) }); });
process.on('unhandledRejection', (e) => { log('error', `${job.name}.unhandled_rejection`, 'fail', { error_code: e?.name || 'Error', error_message: e?.message ?? String(e) }); });
process.on('beforeExit', async () => {
  if (job.ended) return;
  job.ended = true;
  log('job_end', job.name, job.failed || process.exitCode ? 'fail' : 'ok',
    { duration_ms: Date.now() - job.started, payload: { steps: job.steps, http_calls: [...attempts.values()].reduce((a, b) => a + b, 0), exit_code: process.exitCode ?? 0 } });
  await flush();
});
process.on('exit', () => { /* beforeExit handled the async flush; nothing async is possible here */ });

log('job_start', job.name, 'pending', { payload: { workflow: process.env.GITHUB_WORKFLOW || null, run_number: process.env.GITHUB_RUN_NUMBER || null, argv: process.argv.slice(2) } });
void flush();

export const eventlog = { log, flush, step, error, job };
export default eventlog;
