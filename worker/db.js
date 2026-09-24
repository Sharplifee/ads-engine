// One database handle, created on first use rather than at import.
// Importing a module should never require credentials — that made the code
// untestable and meant one missing key broke files that never touch the database.
import { createClient } from '@supabase/supabase-js';

let client = null;
function real() {
  if (client) return client;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Database not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY');
  client = createClient(url, key);
  return client;
}

export const db = new Proxy({}, {
  get: (_t, prop) => {
    const c = real();
    const v = c[prop];
    return typeof v === 'function' ? v.bind(c) : v;
  }
});
