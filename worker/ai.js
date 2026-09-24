// One place for model calls. Six files were each rolling their own fetch with a
// hardcoded model name, no retry and no JSON safety — that is three bugs waiting.
// Model names live in the environment so upgrading is a config change, not a hunt.
const FAST = () => process.env.MODEL_FAST || 'claude-sonnet-5';
const DEEP = () => process.env.MODEL_DEEP || 'claude-opus-5';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function ask({ system, input, max_tokens = 2000, deep = false, attempt = 0 }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
  let res, body;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY,
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: deep ? DEEP() : FAST(), max_tokens, system,
        messages: [{ role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) }] })
    });
    body = await res.json();
  } catch (netErr) {
    if (attempt < 3) { await sleep(2 ** attempt * 1000); return ask({ system, input, max_tokens, deep, attempt: attempt + 1 }); }
    throw new Error(`Model unreachable: ${netErr}`);
  }
  if (!res.ok || body.error) {
    const overloaded = res.status === 429 || res.status >= 500 || body.error?.type === 'overloaded_error';
    if (overloaded && attempt < 3) {
      await sleep(Number(res.headers.get('retry-after')) * 1000 || 2 ** attempt * 3000);
      return ask({ system, input, max_tokens, deep, attempt: attempt + 1 });
    }
    throw new Error(`Model ${res.status}: ${body.error?.message || res.statusText}`);
  }
  return (body.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
}

// Models sometimes wrap JSON in prose or fences. Never let that crash a run.
export async function askJSON(opts) {
  const text = await ask(opts);
  const cleaned = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
  if (start >= 0 && end > start) { try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {} }
  throw new Error(`Model did not return usable JSON (got ${cleaned.slice(0, 120)}…)`);
}
