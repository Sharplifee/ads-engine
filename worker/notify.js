// Alerts have to reach a human or they are not alerts. One webhook, any destination
// (Slack, Discord, a phone relay). Silent when no webhook is set — never a crash.
import { db } from '../worker/db.js';
const HOOK = process.env.ALERT_WEBHOOK_URL;

const ORDER = { high: 0, good: 1, medium: 2, low: 3 };

export async function sendPending({ limit = 20 } = {}) {
  const { data: alerts } = await db.from('ads_alerts')
    .select('id,profile_slug,severity,entity_name,message,raised_at')
    .is('acknowledged_at', null).order('raised_at', { ascending: false }).limit(limit);
  if (!alerts?.length) return { sent: 0 };
  if (!HOOK) return { sent: 0, note: 'ALERT_WEBHOOK_URL not set — alerts stay in the table' };

  const sorted = alerts.sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9));
  const lines = sorted.map(a =>
    `${a.severity === 'good' ? '+' : a.severity === 'high' ? '!' : '-'} [${a.profile_slug}] ${a.message}`);
  const res = await fetch(HOOK, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: lines.join('\n') }) });
  if (!res.ok) return { sent: 0, failed: `webhook ${res.status}` };

  await db.from('ads_alerts').update({ acknowledged_at: new Date().toISOString() })
    .in('id', sorted.map(a => a.id));
  return { sent: sorted.length };
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await sendPending(), null, 2));
