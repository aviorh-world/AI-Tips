// popup.js — ממשק הבודק. כל הפעולות מתחילות מכפתור, שום דבר לא רץ לבד.
let lastFields = [];
let cases = [];
let lastSummary = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ---------- הגדרות ----------
async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  $('aiEnabled').checked = !!settings.aiEnabled;
  $('baseUrl').value = settings.baseUrl || $('baseUrl').value;
  $('model').value = settings.model || $('model').value;
  $('allowlist').value = (settings.allowlist || []).join('\n');
  const sess = await chrome.storage.session.get(['apiKey', 'figmaToken']);
  if (sess.apiKey) $('apiKey').value = sess.apiKey;
  if (sess.figmaToken) $('figmaToken').value = sess.figmaToken;
}

async function saveSettings() {
  const settings = {
    aiEnabled: $('aiEnabled').checked,
    baseUrl: $('baseUrl').value.trim(),
    model: $('model').value.trim(),
    allowlist: $('allowlist').value.split('\n').map((s) => s.trim()).filter(Boolean)
  };
  await chrome.storage.local.set({ settings });
  await chrome.storage.session.set({ apiKey: $('apiKey').value.trim(), figmaToken: $('figmaToken').value.trim() });
  await refreshEnvBanner();
  $('out').textContent = 'ההגדרות נשמרו.';
}

async function isAllowed(url) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const host = hostOf(url);
  return (settings.allowlist || []).some((d) => host === d || host.endsWith('.' + d));
}

async function refreshEnvBanner() {
  const tab = await activeTab();
  const host = hostOf(tab && tab.url);
  $('hostLabel').textContent = host;
  const banner = $('envBanner');
  if (await isAllowed(tab.url)) {
    banner.className = 'ok';
    banner.textContent = 'סביבה מורשית: ' + host + ' — הרצה מותרת';
  } else {
    banner.className = 'blocked';
    banner.textContent = 'לא מורשה: ' + host + ' — הרצה חסומה. אפשר לסרוק ולהקליט.';
  }
}

// ---------- סריקה והקלטה ----------
async function scanPage() {
  const tab = await activeTab();
  try {
    lastFields = await chrome.tabs.sendMessage(tab.id, { type: 'scan' });
    $('out').innerHTML = `<div class="hint">נמצאו ${lastFields.length} אלמנטים</div>` +
      '<table><tr><th>תווית</th><th>סוג</th><th>חובה</th><th>locator</th></tr>' +
      lastFields.map((f) => `<tr><td>${esc(f.label || f.text || f.name)}</td><td>${esc(f.inputType || f.tag)}</td><td>${f.required ? 'כן' : ''}</td><td class="muted">${esc(f.locators[0])}</td></tr>`).join('') +
      '</table>';
  } catch (e) {
    $('out').textContent = 'הסריקה נכשלה. ייתכן שהדף לא נתמך או שהתוסף לא נטען: ' + e.message;
  }
}

async function toggleRecord() {
  const tab = await activeTab();
  const { recording = false } = await chrome.storage.session.get('recording');
  const next = !recording;
  if (next) {
    await chrome.runtime.sendMessage({ type: 'injectHooks', tabId: tab.id });
    await chrome.storage.session.set({ startUrl: tab.url, recordStart: Date.now() });
  }
  await chrome.tabs.sendMessage(tab.id, { type: 'record', on: next });
  await chrome.storage.session.set({ recording: next });
  $('btnRecord').classList.toggle('on', next);
  $('btnRecord').textContent = next ? 'עצור הקלטה' : 'הקלט flow';
  if (!next) renderSteps();
}

async function renderSteps() {
  const steps = await chrome.runtime.sendMessage({ type: 'getSteps' });
  $('out').innerHTML = `<div class="hint">הוקלטו ${steps.length} צעדים</div>` +
    '<table><tr><th>#</th><th>פעולה</th><th>פרטים</th></tr>' +
    steps.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.action)}</td><td>${esc(s.label || s.text || s.value || '')}</td></tr>`).join('') +
    '</table>';
}

// ---------- יצירת מקרים ----------
function renderCases() {
  if (!cases.length) { $('out').textContent = 'אין מקרים. סרוק מסך קודם.'; return; }
  $('out').innerHTML = '<table><tr><th>אשר</th><th>שדה</th><th>מקור</th><th>תיאור</th><th>ערך</th><th>ציפייה</th></tr>' +
    cases.map((c, i) => `<tr><td><input type="checkbox" data-i="${i}" ${c.approved ? 'checked' : ''}></td>
      <td>${esc(c.field)}</td><td class="muted">${c.source === 'ai' ? 'AI (השערה)' : 'דטרמיניסטי'}</td>
      <td>${esc(c.name)}</td><td>${esc(c.value)}</td><td>${c.expect === 'ok' ? 'תקין' : c.expect === 'error' ? 'שגיאה' : 'לא משנה'}</td></tr>`).join('') +
    '</table>';
  $('out').querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => { cases[+cb.dataset.i].approved = cb.checked; });
  });
}

async function generateCases() {
  if (!lastFields.length) { $('out').textContent = 'סרוק מסך לפני יצירת מקרים.'; return; }
  const det = casesForAll(lastFields);
  cases = [...det.map((c) => ({ ...c, approved: true }))];
  renderCases();
}

async function aiCases() {
  if (!lastFields.length) { $('out').textContent = 'סרוק מסך קודם.'; return; }
  const steps = await chrome.runtime.sendMessage({ type: 'getSteps' });
  $('out').textContent = 'מבקש הצעות מה-AI...';
  const res = await chrome.runtime.sendMessage({ type: 'proposeAI', fields: lastFields, steps, requirement: $('expectText').value });
  if (res && res.error) { $('out').textContent = 'שגיאה: ' + res.error; return; }
  cases = [...cases.filter((c) => c.source !== 'ai'), ...res];
  renderCases();
}

// ---------- הרצה ----------
async function runAll() {
  const tab = await activeTab();
  if (!(await isAllowed(tab.url))) { $('out').textContent = 'הסביבה לא מורשית. ההרצה חסומה.'; return; }
  const dryRun = $('dryRun').checked; // ברירת מחדל: dry-run פעיל
  const approved = cases.filter((c) => c.approved);
  const steps = await chrome.runtime.sendMessage({ type: 'getSteps' });
  const rows = [];

  if (approved.length) {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'checkFields', cases: approved });
    rows.push(...r.map((x) => ({ kind: 'שדה', name: `${x.field}: ${x.name}`, ok: x.ok, note: x.error || ('נצפה: ' + x.observed) })));
  }
  if (steps.length) {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'runSteps', steps, dryRun, allowDestructive: false });
    rows.push(...r.map((x) => ({ kind: 'flow', name: `צעד ${x.index + 1} (${x.action})`, ok: x.ok, note: x.error || x.note || '' })));
  }
  $('out').innerHTML = `<div class="hint">${dryRun ? 'dry-run פעיל: הפעולות לא בוצעו, רק נבדקו' : 'מצב אמיתי: הפעולות בוצעו בדף'}</div>` +
    '<table><tr><th>סוג</th><th>בדיקה</th><th>תוצאה</th><th>הערה</th></tr>' +
    rows.map((r) => `<tr><td>${r.kind}</td><td>${esc(r.name)}</td><td class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'עבר' : 'נכשל'}</td><td>${esc(r.note)}</td></tr>`).join('') +
    '</table>';
}

// ---------- סיכום ודוח ----------
async function showSummary() {
  const v = $('sumMinutes').value;
  lastSummary = await chrome.runtime.sendMessage({ type: 'summary', minutes: v === 'rec' ? 'rec' : +v });
  $('sumOut').value = JSON.stringify(lastSummary, null, 2);
}

async function summarizeAI() {
  if (!lastSummary) await showSummary();
  $('sumOut').value = 'מבקש סיכום מה-AI...';
  const res = await chrome.runtime.sendMessage({ type: 'summarizeAI', summary: lastSummary, requirement: $('expectText').value });
  $('sumOut').value = res.error ? 'שגיאה: ' + res.error : 'סיכום AI (הערכה, לא עובדה):\n' + res.text;
}

function tfsDraft() {
  const events = (lastSummary && lastSummary.timeline) || [];
  const errors = events.filter((e) => e.kind === 'request_failed' || e.kind === 'request_error' || e.kind === 'console' || e.kind === 'exception');
  const steps = events.filter((e) => ['click', 'fill', 'expect'].includes(e.type));
  $('sumOut').value = [
    'כותרת: [שם המסך] — ',
    'סביבה: ' + ($('hostLabel').textContent || ''),
    '',
    'שלבי שחזור:',
    ...steps.map((s, i) => `${i + 1}. ${s.type}: ${s.label || s.value || ''}`),
    '',
    'תוצאה צפויה: ',
    'תוצאה בפועל: ',
    '',
    'שגיאות שנצפו:',
    ...errors.map((e) => `- [${e.t}] ${e.kind} ${e.status || ''} ${e.url || e.msg || ''}`),
    '',
    'הערה: הטקסט נוצר אוטומטית. בדוק לפני שליחה.'
  ].join('\n');
  navigator.clipboard.writeText($('sumOut').value).catch(() => {});
}

// ---------- נגישות (axe-core) ----------
async function axeCheck() {
  const tab = await activeTab();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['vendor/axe.min.js'] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        const r = await window.axe.run();
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }));
      }
    });
    const v = res.result;
    $('out').innerHTML = `<div class="hint">נמצאו ${v.length} סוגי הפרות</div>` +
      '<table><tr><th>כלל</th><th>חומרה</th><th>תיאור</th><th>אלמנטים</th></tr>' +
      v.map((x) => `<tr><td>${esc(x.id)}</td><td>${esc(x.impact)}</td><td>${esc(x.help)}</td><td>${x.nodes}</td></tr>`).join('') +
      '</table>';
  } catch (e) {
    $('out').textContent = 'הבדיקה נכשלה. ודא שהקובץ vendor/axe.min.js קיים: ' + e.message;
  }
}

// ---------- השוואה ל-Figma (v2) ----------
async function loadImage(src) {
  const blob = await (await fetch(src)).blob();
  return createImageBitmap(blob);
}

async function figmaCompare() {
  const token = $('figmaToken').value.trim();
  const file = $('figmaFile').value.trim();
  const node = $('figmaNode').value.trim();
  const tol = Math.max(0, Math.min(255, +$('figmaTol').value || 16));
  let ignore = [];
  try { ignore = JSON.parse($('figmaIgnore').value || '[]'); } catch { $('figmaOut').textContent = 'אזורים להתעלמות חייבים להיות JSON של [x,y,w,h]'; return; }
  const uploaded = $('designImage').files[0];
  if (!uploaded && (!token || !file || !node)) { $('figmaOut').textContent = 'העלו תמונה של העיצוב, או מלאו טוקן, מזהה קובץ ומזהה צומת של Figma.'; return; }

  $('figmaOut').textContent = uploaded ? 'קורא את התמונה...' : 'מושך את העיצוב מ-Figma...';
  try {
    let figBmp;
    if (uploaded) {
      figBmp = await createImageBitmap(uploaded);
    } else {
      const meta = await (await fetch(`https://api.figma.com/v1/images/${encodeURIComponent(file)}?ids=${encodeURIComponent(node)}&format=png&scale=1`, {
        headers: { 'X-Figma-Token': token }
      })).json();
      const url = meta.images && meta.images[node];
      if (!url) throw new Error('Figma לא החזיר תמונה לצומת הזה');
      figBmp = await loadImage(url);
    }

    const tab = await activeTab();
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const shotBmp = await loadImage(shot);

    const w = figBmp.width, h = figBmp.height;
    const cFig = new OffscreenCanvas(w, h), cShot = new OffscreenCanvas(w, h);
    cFig.getContext('2d').drawImage(figBmp, 0, 0);
    cShot.getContext('2d').drawImage(shotBmp, 0, 0, w, h);
    const a = cFig.getContext('2d').getImageData(0, 0, w, h).data;
    const b = cShot.getContext('2d').getImageData(0, 0, w, h).data;

    const diffCanvas = new OffscreenCanvas(w, h);
    const dctx = diffCanvas.getContext('2d');
    const out = dctx.createImageData(w, h);
    const inIgnore = (x, y) => ignore.some(([ix, iy, iw, ih]) => x >= ix && x < ix + iw && y >= iy && y < iy + ih);
    let mismatch = 0, total = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (inIgnore(x, y)) { out.data.set([128, 128, 128, 255], i); continue; }
        total++;
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (d > tol) {
          mismatch++;
          out.data.set([255, 0, 0, 255], i);
        } else {
          out.data.set([a[i], a[i + 1], a[i + 2], 80], i);
        }
      }
    }
    dctx.putImageData(out, 0, 0);
    const pct = total ? ((mismatch / total) * 100).toFixed(2) : '0';
    const blob = await diffCanvas.convertToBlob();
    const link = URL.createObjectURL(blob);
    $('diffPreview').src = link;
    $('diffPreview').style.display = 'block';
    const ratioOff = Math.abs(shotBmp.width / shotBmp.height - w / h) > 0.02;
    $('figmaOut').innerHTML = (ratioOff ? '<b>שימו לב: היחס בין רוחב לגובה שונה בין העיצוב למסך, ולכן ההשוואה תהיה גסה.</b><br>' : '') +
      `הפרש: ${pct}% (${mismatch} פיקסלים מתוך ${total}). אדום = שונה. ` +
      `<a href="${link}" download="figma-diff.png">הורד תמונת הפרש</a>` +
      `<div class="muted">הערה: צילום מסך של הדף מותאם לגודל הפריים. אם היחס שונה, ההשוואה לא תהיה מדויקת.</div>`;
  } catch (e) {
    $('figmaOut').textContent = 'ההשוואה נכשלה: ' + e.message;
  }
}

// ---------- ייצוא ----------
function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
}

function locExpr(loc) {
  const idx = loc.indexOf(':');
  const kind = loc.slice(0, idx), val = loc.slice(idx + 1);
  if (kind === 'label') return `page.getByLabel(${JSON.stringify(val)})`;
  if (kind === 'text') return `page.getByText(${JSON.stringify(val)}, { exact: true })`;
  return `page.locator(${JSON.stringify(val)})`;
}

async function exportPlaywright() {
  const steps = await chrome.runtime.sendMessage({ type: 'getSteps' });
  const { startUrl = '' } = await chrome.storage.session.get('startUrl');
  const lines = steps.map((s) => {
    const loc = (s.locators || [])[0];
    if (s.action === 'fill') return `  await ${locExpr(loc)}.fill(${JSON.stringify(s.value)});`;
    if (s.action === 'click') return `  await ${locExpr(loc)}.click();`;
    if (s.action === 'expect') return `  await expect(page.getByText(${JSON.stringify(s.text)})).toBeVisible();`;
    return '';
  });
  const spec = `import { test, expect } from '@playwright/test';\n\ntest('flow מ-QA Companion', async ({ page }) => {\n  await page.goto(${JSON.stringify(startUrl)});\n${lines.join('\n')}\n});\n`;
  download('flow.spec.ts', spec, 'text/plain');
}

async function exportJson() {
  const steps = await chrome.runtime.sendMessage({ type: 'getSteps' });
  download('flow.json', JSON.stringify({ steps }, null, 2));
}

// ---------- בדיקת חיבור ל-AI ----------
async function testAI() {
  const base = $('baseUrl').value.trim();
  const key = $('apiKey').value.trim();
  try {
    const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id);
    $('out').textContent = ids.includes($('model').value.trim())
      ? 'החיבור תקין והמודל זמין.'
      : 'החיבור תקין, אבל המודל לא מופיע ברשימה. בדוק את שם המודל.';
  } catch (e) {
    $('out').textContent = 'החיבור נכשל: ' + e.message;
  }
}

async function showAudit() {
  const audit = await chrome.runtime.sendMessage({ type: 'audit' });
  $('auditOut').textContent = audit.length ? JSON.stringify(audit.slice(-20), null, 2) : 'אין רישומים עדיין.';
}

// ---------- חיווט ----------
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await refreshEnvBanner();
  const { recording = false } = await chrome.storage.session.get('recording');
  $('btnRecord').classList.toggle('on', recording);
  if (recording) $('btnRecord').textContent = 'עצור הקלטה';

  $('btnScan').onclick = scanPage;
  $('btnRecord').onclick = toggleRecord;
  $('btnGen').onclick = generateCases;
  $('btnRun').onclick = runAll;
  $('btnAddExpect').onclick = async () => {
    const text = $('expectText').value.trim();
    if (!text) return;
    await chrome.runtime.sendMessage({ type: 'addExpect', text });
    $('out').textContent = 'הציפייה נוספה לזרם ההקלטה.';
  };
  $('btnSummary').onclick = showSummary;
  $('btnSummarizeAI').onclick = summarizeAI;
  $('btnTfs').onclick = async () => { if (!lastSummary) await showSummary(); tfsDraft(); };
  $('btnCopySum').onclick = () => navigator.clipboard.writeText($('sumOut').value);
  $('btnAxe').onclick = axeCheck;
  $('btnFigma').onclick = figmaCompare;
  $('btnSaveSettings').onclick = saveSettings;
  $('btnTestAI').onclick = testAI;
  $('btnAudit').onclick = showAudit;
  $('btnExportJson').onclick = exportJson;
  $('btnExportPw').onclick = exportPlaywright;
  $('btnClearSteps').onclick = async () => { await chrome.runtime.sendMessage({ type: 'clearSteps' }); $('out').textContent = 'ההקלטה נוקתה.'; };
  $('btnAIcases').onclick = aiCases;
});
