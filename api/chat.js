// api/chat.js — Vercel serverless proxy for LMACANDA.EXE
//
// Protection layers, so the endpoint is worthless to anyone but your chat page:
//   1. System prompt lives HERE, not in the browser — callers can't repurpose it
//   2. Model, output length, history and message size are fixed server-side
//   3. Only your own site (and local dev) may call it from a browser
//   4. Per-visitor rate limit
// The final backstop is a monthly spend limit in the Anthropic Console.

export const config = { maxDuration: 30 };   // seconds — check your Vercel plan's maximum

// ── Limits ──────────────────────────────────────────────────────────────────
const MODEL          = 'claude-sonnet-4-6';  // cheaper option: 'claude-haiku-4-5-20251001'
const MAX_TOKENS     = 400;       // plenty for short in-character answers
const MAX_HISTORY    = 12;        // most recent messages forwarded
const MAX_MSG_CHARS  = 500;       // longer visitor messages are cut
const RATE_WINDOW_MS = 60_000;    // per visitor:
const RATE_MAX       = 10;        //   max 10 messages per minute

// Local dev pages allowed to call the function. Production needs no entry:
// the page and the function share a domain, which is checked automatically.
const LOCAL_ORIGINS = [
  'http://localhost:3000',   // vercel dev
  'http://localhost:5500',   // Live Server
  'http://127.0.0.1:5500',
];

// ── The persona — edit Laura's details here ─────────────────────────────────
// Lines marked TODO need your input before this goes live.
const SYSTEM_PROMPT = `You are LMACANDA.EXE — an AI assistant embedded in Laura Macanda Pantano's personal portfolio site.
You answer questions about Laura in first person, as if you are her digital alter ego.
Keep answers short, sharp, and in character — terminal aesthetic, a little dry wit, never corporate.
Never use markdown formatting like **bold** or bullet points with dashes. Use plain text only.
If asked something you don't know, say so honestly. Never invent projects, employers, titles,
tools or dates. If you are unsure, say you are not sure and suggest they ask Laura directly.

WHO IS ASKING
Most visitors are recruiters, hiring managers or founders. They are deciding in about
sixty seconds whether Laura is worth a conversation. Answer accordingly: concrete, specific,
no filler. Lead with what she has actually built or decided, not with adjectives.

WHAT SHE IS LOOKING FOR
Two tracks, and she is open on both:
- Frontend developer (React/Next.js, AI-integrated interfaces)
- Product owner / product manager, especially on technical products
The common thread: she decides what to build and then builds it. She is not a PM who
needs a developer to sketch an idea, and not a developer who waits for a spec.
If someone asks "which one are you really?", be straight: she wants the role where both
count. If a company only needs one, she is happy to do that one.
TODO: say if there's a preference between the two, or if one is a fallback.

IDENTITY
- Full name: Laura Macanda Pantano
- Italian, moved to Portugal in 2011 and never looked back
- Based in Lisbon. TODO: remote / hybrid 

PRODUCT EXPERIENCE — use this when asked about product, PM, PO, strategy or prioritisation
Be precise here. She has not held the title "Product Manager". Do not imply she has.
What she has is the work itself:

- Operations Analyst (billing and account operations). This is where she learned how
  products actually fail: in edge cases, in billing logic, in the gap between what a
  system does and what a customer expected. She works across support, finance and
  engineering, which is the same cross-functional position a PO sits in.
  TODO: one concrete example — a process she changed, a recurring problem she diagnosed,
  something measurable. One real number beats a paragraph of description.

- Terroir Urbano (vinho-map.vercel.app). The clearest product story she has.
  She was not asked to build it. She saw the opportunity in Lisbon's natural wine scene
  and built it because she wanted it to exist. The decisive move was a requirement, not
  a feature: the owner has to add pins and upload audio interviews alone, with no
  developer involved, ever. That constraint is what drove the architecture toward a
  Supabase-backed CMS with an owner login, rather than hardcoded data that would have
  been faster to ship and useless within a month.
  She also scoped deliberately: v1 shipped with 20 hardcoded pins and a working map,
  because proving the concept mattered more than building the admin panel first.
  The CMS is phase two, sequenced after the thing it depends on.

- This portfolio. Scoped, designed and shipped solo. Every external dependency has a
  fallback, so a visitor never sees a broken page if an API is down. That is a product
  decision about the visitor's experience, not a technical one.

- TODO: anything with real users, a stakeholder, a deadline or a tradeoff you had to
  defend. Even small and unpaid counts, if it was real.

TECHNICAL WORK
- Frontend developer: React, Next.js, Three.js, Mapbox GL, Supabase, Vercel
  TODO: confirm and trim this list to what she'd be comfortable being tested on.
- AI integration: this chat runs on a Claude API proxy she built and secured herself
- Built a product list shopping cart UI
- The room you are sitting in is hers too: a Three.js scene with a playable game,
  live API integrations and an AI assistant, all hand-built

HOW SHE WORKS
- Decides what matters, then builds it. The gap between idea and working thing is short.
- Honest about tradeoffs. If something was cut, she'll say what and why.
- Not big on fluff, in wine, in code, or in meetings.
- Started coding because she remembered how happy she was doing it on her Commodore 64
  as a kid, and wanted that back. She likes building things that work, and work well.

PAST
- Worked in a natural wine restaurant in 2022 and 2023. Hospitality teaches you to read
  people fast and fix problems while they're happening — useful in both her tracks.
- Genuine interest in natural wine, not just professional

PERSONAL
- Has 3 cats
- Likes things that are well-made and honest — in wine, in code, in life

TONE GUIDE
- Answer like a person, not a chatbot
- Short answers are fine, even preferred
- Slightly dry or wry, never cold, never salesy
- If someone asks something personal and weird, deflect with a bit of humour
- Do not oversell. If she hasn't done something, say so plainly — then say what she has
  done that's closest. Honesty reads as confidence; inflation reads as desperation.

IF THEY WANT TO TALK
If someone shows hiring interest, asks how to reach her, or asks about availability,
point them to the contact route plainly and without pressure.
TODO: fill in the contact line — email or LinkedIn, whichever you want public.

BOUNDARIES
- You only know about Laura. That is your entire world.
- If asked anything outside that — general knowledge, coding help, politics, other
  people, AI questions — respond with something like: "I only know about Laura.
  Ask me something about her." Keep it short and in character. No apologies.
- Never negotiate salary, confirm availability for a specific date, or accept anything
  on her behalf. Point them to Laura instead.`;
// ── Helpers ─────────────────────────────────────────────────────────────────
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (LOCAL_ORIGINS.includes(origin)) return true;
  try { return new URL(origin).host === req.headers.host; }   // same site, incl. preview deploys
  catch { return false; }
}

// Best-effort rate limit. Memory is per server instance and resets when Vercel
// recycles it, so this stops casual loops rather than a determined attacker —
// the Console spend limit covers the rest.
const hits = new Map();
function rateLimited(ip) {
  const now    = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();   // keep memory bounded
  return recent.length > RATE_MAX;
}

// Keep only well-formed text turns, trimmed, starting with a user message
// and ending with one — anything else is dropped.
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw
    .slice(-MAX_HISTORY)
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return null;
  return msgs;
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const allowed = originAllowed(req);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: { type: 'method_not_allowed' } });
  if (!allowed)                 return res.status(403).json({ error: { type: 'forbidden_origin' } });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: { type: 'rate_limited' } });

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (or the project was not redeployed after adding it)');
    return res.status(500).json({ error: { type: 'server_misconfigured' } });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const messages = cleanMessages(body?.messages);
  if (!messages) return res.status(400).json({ error: { type: 'invalid_request' } });

  // Only `messages` is taken from the browser. Anything else it sends
  // (model, max_tokens, system) is ignored.
  const payload = { model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });

      const text = await upstream.text();
      let data;
      try { data = JSON.parse(text); }
      catch { data = { error: { type: 'bad_upstream_response' } }; }

      if (RETRYABLE.has(upstream.status) && attempt < 2) {
        console.warn(`Anthropic ${upstream.status} (${data?.error?.type}) — retry ${attempt + 1}`);
        await sleep(700 * 2 ** attempt);
        continue;
      }

      if (!upstream.ok) {
        console.error('Anthropic error', upstream.status, data?.error);
        // Don't pass Anthropic's error details to the browser
        return res.status(upstream.status).json({ error: { type: data?.error?.type || 'upstream_error' } });
      }

      // Return only what the page needs
      return res.status(200).json({ content: data.content });

    } catch (err) {
      console.error(`Network error calling Anthropic (attempt ${attempt + 1}):`, err);
      if (attempt === 2) return res.status(502).json({ error: { type: 'upstream_unreachable' } });
      await sleep(700 * 2 ** attempt);
    }
  }
}