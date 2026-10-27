/* ============================================================================
   Claude assistant for the Protection Lead Tracker — a Cloudflare Worker.

   The tracker is a static site, so it can't hold an API key. This Worker
   holds it instead: the tracker sends a task and the case details along with
   the colleague's Firebase sign-in token; the Worker checks with the
   tracker's own database that they're a signed-in colleague, then asks
   Claude and returns the answer.

   Set up (Cloudflare dashboard → Workers & Pages → Create → Worker):
     1. Paste this whole file in as the Worker's code and Deploy.
     2. Settings → Variables and Secrets:
          ANTHROPIC_API_KEY  (Secret)  your Claude API key (console.anthropic.com)
          FIREBASE_DB_URL    (Text)    https://protection-dashboard-6aa9a-default-rtdb.europe-west1.firebasedatabase.app
          ALLOWED_ORIGINS    (Text)    https://rolfey11.github.io
     3. Copy the Worker's address (…workers.dev) into the tracker:
        Settings → Templates & prompts → AI assistant.

   What it does: ✨ Ask Claude (a chat), ✨ Summarise this case, ✨ Write with
   AI (email drafts) and ✨ Tidy up (notes). Nothing is stored here.

   Calls Claude's Messages API over plain HTTPS (fetch): a pasted-in Worker
   has no build step to install the Anthropic SDK with.
   ============================================================================ */

const MODEL = 'claude-sonnet-5-5';
const MAX_INPUT_CHARS = 60000;

const HOUSE = `You help advisers at Michael Usher Mortgage Services, a UK mortgage and protection brokerage, with their case tracker.
Write in UK English. Use only the facts in the case details you're given; never invent figures, dates, names, health details, prices or promises. If something isn't in the case, leave it out.`;

// What the tracker can ask for. The prompts live here, not in the browser.
const TASKS = {
  summary: {
    effort: 'medium',
    system: `${HOUSE}

Summarise the case for a busy adviser who is picking it up. Base it on the case details and history; the most recent entries matter most.
- summary: 2 to 4 sentences — who the client is, what they're after, and where the case stands now.
- next_step: one sentence — the most useful next action (for example the booked appointment, a chase that's due, or what the client is waiting for).
- watch_outs: up to 3 short points worth knowing before contacting the client (for example pending medical information, a partner to consult, an overdue item). Empty if there's nothing notable.`,
    schema: {
      type: 'object',
      properties: {
        summary: {type: 'string'},
        next_step: {type: 'string'},
        watch_outs: {type: 'array', items: {type: 'string'}},
      },
      required: ['summary', 'next_step', 'watch_outs'],
      additionalProperties: false,
    },
  },
  email: {
    effort: 'medium',
    system: `${HOUSE}

Draft an email from the adviser to the client, ready for the adviser to check and send.
- Friendly, professional and concise. Open with "Hi" and the client's first name(s). End with "Kind regards," and the adviser's first name on the next line; their email signature is added automatically, so don't add one.
- Follow the adviser's instructions. If a current draft or template is given, keep its purpose and fill any [square-bracket] gaps from the case details; if a detail isn't known, write around it — never leave square brackets.
- Don't state prices, cover amounts, underwriting decisions or deadlines unless they're in the case details or the instructions.
- subject: a short, clear subject line. body: the email text with line breaks, no markdown.`,
    schema: {
      type: 'object',
      properties: {subject: {type: 'string'}, body: {type: 'string'}},
      required: ['subject', 'body'],
      additionalProperties: false,
    },
  },
  ask: {
    effort: 'medium',
    chat: true,
    system: `You are Claude, the assistant built into the case tracker at Michael Usher Mortgage Services, a UK mortgage and protection brokerage. Advisers ask you anything: questions about mortgages, protection and commercial finance, help wording a message, thinking through a case, or everyday work questions.
Write in UK English and keep answers short and practical. Use plain paragraphs, simple "- " bullet points and **bold** only; no headings or tables.
If the adviser includes a case, answer from its details and never invent facts about the client. For rules, rates or lender criteria, give your best general understanding, say it may be out of date, and suggest checking the lender, the source or compliance. You support the adviser; you don't give advice to clients directly.`,
  },
  tidy: {
    effort: 'low',
    system: `${HOUSE}

Tidy the adviser's rough case note into clear, professional notes: fix spelling, grammar and shorthand, and keep every fact, figure, date and name exactly. Don't add anything, don't drop anything, and keep it about the same length or shorter, in the same voice. Plain text, no headings or markdown. Reply with the tidied note only.`,
  },
};

export default {
  async fetch(request, env) {
    const allowed = String(env.ALLOWED_ORIGINS || 'https://rolfey11.github.io').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), {status, headers: {...cors, 'Content-Type': 'application/json'}});

    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    if (request.method !== 'POST') return reply({error: 'Use POST.'}, 405);
    if (!allowed.includes(origin)) return reply({error: 'This website is not allowed to use the assistant.'}, 403);
    if (!env.ANTHROPIC_API_KEY || !env.FIREBASE_DB_URL) return reply({error: 'The assistant is not set up yet (missing ANTHROPIC_API_KEY or FIREBASE_DB_URL).'}, 500);

    // Only signed-in colleagues: the tracker's database only answers
    // /members/{uid} for that same signed-in user, and only once they're linked.
    const token = String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const uid = uidFromToken(token);
    if (!uid) return reply({error: 'Please sign in to the tracker again.'}, 401);
    let member = null;
    try {
      const m = await fetch(`${String(env.FIREBASE_DB_URL).replace(/\/$/, '')}/members/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(token)}`);
      if (m.ok) member = await m.json();
    } catch (e) { /* treated as not signed in */ }
    if (!member) return reply({error: 'Please sign in to the tracker again.'}, 401);

    let body;
    try { body = await request.json(); } catch (e) { return reply({error: 'Bad request.'}, 400); }
    const task = TASKS[body && body.task];
    if (!task) return reply({error: 'Unknown request.'}, 400);
    let messages;
    if (task.chat) {
      // A conversation: alternating user / assistant turns, ending with the adviser's question.
      const turns = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
      messages = turns.map(m => ({role: m && m.role === 'assistant' ? 'assistant' : 'user', content: String((m && m.content) || '').trim()}));
      while (messages.length && messages[0].role !== 'user') messages.shift();
      const ok = messages.length && messages[messages.length - 1].role === 'user' && messages.every((m, i) => m.content && m.role === (i % 2 ? 'assistant' : 'user'));
      if (!ok) return reply({error: 'Bad request.'}, 400);
      if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_INPUT_CHARS) return reply({error: 'This conversation is too long. Press New chat to start again.'}, 413);
    } else {
      const input = String(body.input || '').trim();
      if (!input) return reply({error: 'Nothing to work with.'}, 400);
      if (input.length > MAX_INPUT_CHARS) return reply({error: 'That case is too long to send in one go.'}, 413);
      messages = [{role: 'user', content: input}];
    }

    let res, out;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2026-10-21',
          // If a safety check declines, Claude retries on the recommended fallback model.
          'anthropic-beta': 'server-side-fallback-2026-07-01',
        },
        body: JSON.stringify({
          model: env.MODEL || MODEL,
          max_tokens: 16000,
          fallbacks: 'default',
          system: task.system,
          output_config: {effort: task.effort, ...(task.schema ? {format: {type: 'json_schema', schema: task.schema}} : {})},
          messages,
        }),
      });
      out = await res.json();
    } catch (e) {
      return reply({error: "Couldn't reach Claude. Please try again."}, 502);
    }
    if (!res.ok) {
      const msg = out && out.error && out.error.message;
      return reply({error: res.status === 429 ? 'Claude is busy. Please try again in a minute.' : `Claude returned an error${msg ? ': ' + msg : ''}.`}, 502);
    }
    if (out.stop_reason === 'refusal') return reply({error: "Claude couldn't help with this one."}, 422);
    if (out.stop_reason === 'max_tokens') return reply({error: 'The answer was too long. Please try again.'}, 502);

    const text = (out.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!task.schema) return reply({result: text});
    try { return reply({result: JSON.parse(text)}); }
    catch (e) { return reply({error: 'Claude sent an unexpected reply. Please try again.'}, 502); }
  },
};

// The Firebase user id inside the sign-in token. Not trusted on its own:
// the database checks the token itself when the Worker looks the user up.
function uidFromToken(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4));
    const claims = JSON.parse(json);
    const uid = claims.user_id || claims.sub;
    return typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid) ? uid : null;
  } catch (e) { return null; }
}
