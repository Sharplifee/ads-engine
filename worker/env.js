// Loads .env so every entry point behaves the same, and fails loudly at startup
// instead of halfway through a run with a confusing error.
import { readFileSync, existsSync } from 'node:fs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const NEEDED_FOR = {
  'account monitoring': ['META_ACCESS_TOKEN', 'META_API_VERSION'],
  'competitor scraping': ['APIFY_TOKEN'],
  'video discovery': ['YOUTUBE_API_KEY'],
  'transcripts': ['SUPADATA_API_KEY', 'APIFY_TOKEN'],
  'web discovery': ['FIRECRAWL_API_KEY'],
  'reading and strategy': ['ANTHROPIC_API_KEY'],
  'alerts reaching you': ['ALERT_WEBHOOK_URL']
};

export function loadEnv(path = '.env') {
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  const missing = REQUIRED.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Cannot start — missing ${missing.join(', ')}`);
  return capabilities();
}

export function capabilities() {
  const out = {};
  for (const [what, keys] of Object.entries(NEEDED_FOR))
    out[what] = keys.some(k => process.env[k]) ? 'available'
      : `off — set ${keys.join(' or ')}`;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(loadEnv(), null, 2));
