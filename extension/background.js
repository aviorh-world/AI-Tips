// background.js — service worker. באפר אירועים, שגיאות רשת, צעדי הקלטה, סיכום ושיחות AI.
importScripts('mask.js');

const BUF_MAX = 500;
const BUF_MINUTES = 10;

async function hostAllowed(url) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { return false; }
  return (settings.allowlist || []).some((d) => host === d || host.endsWith('.' + d));
}
const RETRYABLE = [429, 502, 503, 504];

// ---------- תור כתיבה לבאפר (מונע איבוד אירועים בפרץ) ----------
let queue = Promise.resolve();
function pushBuffer(item) {
  queue = queue.then(async () => {
    const { buffer = [] } = await chrome.storage.session.get('buffer');
    buffer.push({ ...item, t: item.t || Date.now() });
    const cutoff = Date.now() - BUF_MINUTES * 60000;
    while (buffer.length && buffer[0].t < cutoff) buffer.shift();
    if (buffer.length > BUF_MAX) buffer.splice(0, buffer.length - BUF_MAX);
    await chrome.storage.session.set({ buffer });
  });
  return queue;
}

// ---------- שגיאות רשת (מבנה בלבד, בלי גוף ובלי query) ----------
// רק בקשות שיצאו מאתר מורשה (initiator), כדי לא לאסוף רעש מכל הגלישה
chrome.webRequest.onCompleted.addListener(async (d) => {
  if (d.statusCode >= 400 && await hostAllowed(d.initiator || d.url)) {
    pushBuffer({ kind: 'request_failed', url: QA_MASK.maskUrl(d.url), status: d.statusCode });
  }
}, { urls: ['<all_urls>'] });

chrome.webRequest.onErrorOccurred.addListener(async (d) => {
  if (await hostAllowed(d.initiator || d.url)) {
    pushBuffer({ kind: 'request_error', url: QA_MASK.maskUrl(d.url), error: d.error });
  }
}, { urls: ['<all_urls>'] });

// ---------- סיכום "מה קרה" ----------
// minutes: מספר דקות אחורה, או 'rec' = מאז שהתחילה ההקלטה האחרונה
async function buildSummary(minutes) {
  const { buffer = [] } = await chrome.storage.session.get('buffer');
  const { steps = [], recordStart } = await chrome.storage.session.get(['steps', 'recordStart']);
  const since = minutes === 'rec' ? (recordStart || 0) : Date.now() - minutes * 60000;
  const m = (x) => (typeof x === 'string' ? QA_MASK.mask(x) : x);

  // הקופסה השחורה כבר מכילה לחיצות והקלדות; מההקלטה לוקחים רק את הציפיות שהבודק סימן
  const timeline = [
    ...steps.filter((s) => s.action === 'expect').map((s) => ({ t: s.t, kind: 'expect', type: 'expect', label: m(s.text || '') })),
    ...buffer.map((b) => ({ ...b, type: b.kind, msg: m(b.msg), label: m(b.label), t: b.t }))
  ]
    .filter((x) => x.t >= since)
    .sort((a, b) => a.t - b.t)
    .map((x) => ({ ...x, t: new Date(x.t).toLocaleTimeString('he-IL') }));

  // תקרת גודל: אם יותר מדי, שומרים את האחרונים ומסמנים כמה נחתך
  const MAX_ITEMS = 150;
  const cut = Math.max(0, timeline.length - MAX_ITEMS);
  return { minutes, cutItems: cut, timeline: timeline.slice(-MAX_ITEMS) };
}

// ---------- קריאה ל-AI (OpenAI-compatible) ----------
async function callAI(settings, apiKey, userPrompt, systemPrompt) {
  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: 3000,
    stream: false,
    response_format: { type: 'json_object' }
  };

  const delays = [3000, 8000];
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const r = await fetch(settings.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (r.ok) {
        const j = await r.json();
        return j.choices[0].message.content;
      }
      if (!RETRYABLE.includes(r.status) || attempt >= delays.length) {
        throw new Error('שגיאת שער: HTTP ' + r.status);
      }
    } catch (e) {
      clearTimeout(timer);
      if (attempt >= delays.length) throw e;
    }
    await new Promise((res) => setTimeout(res, delays[attempt]));
  }
}

function validateCases(raw, allowedFields) {
  let obj;
  try { obj = JSON.parse(raw); } catch { throw new Error('תשובת ה-AI אינה JSON תקין'); }
  const arr = Array.isArray(obj.cases) ? obj.cases : [];
  return arr
    .filter((c) =>
      typeof c.field === 'string' && allowedFields.includes(c.field) &&
      typeof c.name === 'string' && c.name.length <= 120 &&
      typeof c.value === 'string' && c.value.length <= 300 &&
      ['ok', 'error'].includes(c.expect))
    .slice(0, 10)
    .map((c) => ({ ...c, source: 'ai', approved: false }));
}

async function appendAudit(entry) {
  const { audit = [] } = await chrome.storage.local.get('audit');
  audit.push({ ts: new Date().toISOString(), ...entry });
  if (audit.length > 500) audit.splice(0, audit.length - 500);
  await chrome.storage.local.set({ audit });
}

async function proposeAI({ fields, steps, requirement }) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const { apiKey } = await chrome.storage.session.get('apiKey');
  if (!settings.aiEnabled || !apiKey) throw new Error('AI כבוי או שאין מפתח');

  const labels = fields.map((f) => f.label || f.name).filter(Boolean);
  const safeFields = fields.map((f) => ({
    label: QA_MASK.mask(f.label || f.name), inputType: f.inputType, required: f.required,
    maxlength: f.maxlength, min: f.min, max: f.max
  }));
  const safeSteps = steps.map((s) => ({ action: s.action, label: QA_MASK.mask(s.label || ''), text: QA_MASK.mask(s.text || '') }));
  const req = QA_MASK.mask(requirement || '');

  const system = 'אתה עוזר לבודקי QA. החזר JSON בלבד בצורה {"cases":[{"field":"<label מהרשימה>","name":"<תיאור בעברית>","value":"<ערך>","expect":"ok|error"}]}. עד 10 מקרים. אל תמציא שדות שלא ברשימה.';
  const user = `שדות: ${JSON.stringify(safeFields)}\nצעדי flow: ${JSON.stringify(safeSteps)}\nדרישה: ${req}`;

  const raw = await callAI(settings, apiKey, user, system);
  await appendAudit({ model: settings.model, purpose: 'propose', bytes: user.length, fieldCount: safeFields.length, stepCount: safeSteps.length });
  return validateCases(raw, labels);
}

async function summarizeAI(summary, requirement) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const { apiKey } = await chrome.storage.session.get('apiKey');
  if (!settings.aiEnabled || !apiKey) throw new Error('AI כבוי או שאין מפתח');

  const user = `אירועים לפי סדר זמן (מסווים): ${JSON.stringify(summary.timeline).slice(0, 24000)}\nהקשר: ${QA_MASK.mask(requirement || '')}`;
  const system = 'אתה עוזר לבודקי QA. סכם בעברית מה קרה: מה הבודק עשה, איזה שירות נכשל, ואיזה שגיאה הופיעה. לכל טענה ציין את הזמן מהציר. סמן כל השערה כ"השערה". החזר JSON בצורה {"summary":"...","hypotheses":["..."]}.';
  const raw = await callAI(settings, apiKey, user, system);
  await appendAudit({ model: settings.model, purpose: 'summarize', bytes: user.length, events: summary.timeline.length });
  return raw;
}

// ---------- נקודת כניסה להודעות ----------
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    switch (msg.type) {
      case 'buffer':
        await pushBuffer(msg.item);
        respond({ ok: true });
        break;
      case 'step': {
        const { steps = [] } = await chrome.storage.session.get('steps');
        steps.push(msg.step);
        await chrome.storage.session.set({ steps });
        respond({ ok: true });
        break;
      }
      case 'addExpect': {
        const { steps = [] } = await chrome.storage.session.get('steps');
        steps.push({ action: 'expect', text: msg.text, t: Date.now() });
        await chrome.storage.session.set({ steps });
        respond({ ok: true });
        break;
      }
      case 'getSteps': {
        const { steps = [] } = await chrome.storage.session.get('steps');
        respond(steps);
        break;
      }
      case 'clearSteps':
        await chrome.storage.session.set({ steps: [] });
        respond({ ok: true });
        break;
      case 'summary':
        respond(await buildSummary(msg.minutes));
        break;
      case 'injectHooks':
        await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, world: 'MAIN', files: ['hooks.js'] });
        respond({ ok: true });
        break;
      case 'proposeAI':
        respond(await proposeAI(msg));
        break;
      case 'summarizeAI':
        respond({ text: await summarizeAI(msg.summary, msg.requirement) });
        break;
      case 'audit': {
        const { audit = [] } = await chrome.storage.local.get('audit');
        respond(audit);
        break;
      }
      default:
        respond({ error: 'הודעה לא מוכרת' });
    }
  })().catch((e) => respond({ error: e.message }));
  return true;
});
