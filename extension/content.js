// content.js — רץ בתוך הדף (isolated world). סריקה, הקלטה, בדיקת שדות והרצת צעדים.
(() => {
  if (window.__qaContentLoaded) return;
  window.__qaContentLoaded = true;

  let recording = false;
  // פעולות שמחכות לאישור מפורש. ניתן לעקוף רק עם allowDestructive.
  const DESTRUCTIVE = /מחק|שלח|שלם|אשר|הסר|delete|remove|pay|send|submit|approve/i;

  // ---------- זיהוי אלמנטים ----------
  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function labelText(el) {
    if (el.labels && el.labels[0]) return el.labels[0].innerText.trim().slice(0, 60);
    return (el.getAttribute('aria-label') || el.placeholder || '').slice(0, 60);
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  // סדר העדיפות: id יציב, name, תווית, טקסט כפתור, ואז נתיב CSS כגיבוי אחרון
  function buildLocators(el) {
    const out = [];
    if (el.id && !/\d{4,}/.test(el.id)) out.push('css:#' + el.id);
    if (el.name) out.push(`css:[name="${el.name}"]`);
    const lbl = labelText(el);
    if (lbl) out.push('label:' + lbl);
    const txt = (el.innerText || el.value || '').trim().slice(0, 60);
    if (txt && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button')) out.push('text:' + txt);
    out.push('css:' + cssPath(el));
    return out;
  }

  function scan() {
    return [...document.querySelectorAll('input,select,textarea,button,a[href],[role=button]')]
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        inputType: el.type || null,
        name: el.name || el.id || '',
        label: labelText(el),
        required: !!el.required,
        maxlength: el.maxLength > 0 ? el.maxLength : null,
        min: el.min || null,
        max: el.max || null,
        text: (el.innerText || el.value || '').trim().slice(0, 60),
        locators: buildLocators(el)
      }));
  }

  // ---------- פתרון locators ----------
  function resolve(loc) {
    const idx = loc.indexOf(':');
    const kind = loc.slice(0, idx);
    const val = loc.slice(idx + 1);
    try {
      if (kind === 'css') return document.querySelector(val);
      if (kind === 'label') {
        for (const l of document.querySelectorAll('label')) {
          if (l.innerText.trim() === val) {
            return l.control || (l.htmlFor && document.getElementById(l.htmlFor)) || l.querySelector('input,select,textarea');
          }
        }
        return [...document.querySelectorAll('[aria-label],[placeholder]')].find(
          (e) => e.getAttribute('aria-label') === val || e.placeholder === val
        ) || null;
      }
      if (kind === 'text') {
        return [...document.querySelectorAll('button,a,[role=button],input[type=submit]')].find(
          (e) => (e.innerText || e.value || '').trim() === val
        ) || null;
      }
    } catch { /* locator לא תקין, ננסה את הבא */ }
    return null;
  }

  function findByLocators(locators, timeout = 3000) {
    return new Promise((resolveP) => {
      const start = Date.now();
      const tick = () => {
        for (const loc of locators) {
          const el = resolve(loc);
          if (el) return resolveP(el);
        }
        if (Date.now() - start > timeout) return resolveP(null);
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  // ---------- הזנת ערך שמעדכן גם React/Vue ----------
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- בדיקת שדות (ללא שליחת טופס) ----------
  async function checkFields(cases) {
    const results = [];
    for (const c of cases) {
      const r = { name: c.name, field: c.field, ok: false };
      try {
        const el = await findByLocators(c.locators);
        if (!el) throw new Error('שדה לא נמצא');
        const original = el.value;
        setValue(el, c.value);
        const valid = el.checkValidity();
        const expectValid = c.expect === 'ok';
        r.ok = c.expect === 'any' ? true : valid === expectValid;
        r.observed = valid ? 'תקין' : 'שגיאת ולידציה';
        setValue(el, original);
      } catch (e) {
        r.error = e.message;
      }
      results.push(r);
    }
    return results;
  }

  // ---------- הרצת צעדי flow ----------
  async function runSteps(steps, { dryRun, allowDestructive }) {
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const r = { index: i, action: s.action, ok: false };
      try {
        if (s.action === 'expect') {
          const start = Date.now();
          while (!document.body.innerText.includes(s.text)) {
            if (Date.now() - start > 3000) throw new Error('הטקסט לא הופיע: ' + s.text);
            await new Promise((res) => setTimeout(res, 150));
          }
          r.ok = true;
        } else {
          const el = await findByLocators(s.locators);
          if (!el) throw new Error('אלמנט לא נמצא');
          if (s.action === 'click') {
            const label = (s.label || el.getAttribute('aria-label') || el.title || '').trim();
            if (!allowDestructive && !label) {
              throw new Error('כפתור בלי שם נחסם: לא לוחצים על מה שלא יודעים מה הוא עושה');
            }
            if (!allowDestructive && DESTRUCTIVE.test(label)) {
              throw new Error('פעולה הרסנית נחסמה: ' + label);
            }
            if (dryRun) r.note = 'dry-run: לא בוצע';
            else el.click();
          } else if (s.action === 'fill') {
            if (dryRun) r.note = 'dry-run: לא בוצע';
            else setValue(el, s.value);
          }
          r.ok = true;
          await new Promise((res) => setTimeout(res, dryRun ? 0 : 400));
        }
      } catch (e) {
        r.error = e.message;
      }
      results.push(r);
      if (!r.ok) break;
    }
    return results;
  }

  // ---------- קופסה שחורה: תמיד שומרת, רק באתרים מורשים ----------
  // allowed: null = עוד לא ידוע (אירועים מחכים בתור), true/false אחרי קריאת ההגדרות
  let allowed = null;
  const pending = [];
  function checkAllowed(settings) {
    const host = location.hostname;
    allowed = ((settings && settings.allowlist) || []).some((d) => host === d || host.endsWith('.' + d));
    if (allowed) pending.splice(0).forEach((item) => chrome.runtime.sendMessage({ type: 'buffer', item }));
    else pending.length = 0;
  }
  chrome.storage.local.get('settings').then(({ settings }) => checkAllowed(settings));
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) checkAllowed(ch.settings.newValue); });
  function toBuffer(item) {
    item.t = item.t || Date.now();
    if (allowed === null) pending.push(item);
    else if (allowed) chrome.runtime.sendMessage({ type: 'buffer', item });
  }

  // ---------- הקלטה ----------
  function sendStep(step) {
    chrome.runtime.sendMessage({ type: 'step', step });
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('button,a,[role=button]');
    if (!el) return;
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 60);
    const locators = buildLocators(el);
    toBuffer({ kind: 'click', label: label || '(כפתור בלי שם)', locator: locators[0] });
    if (recording) sendStep({ action: 'click', locators, label, t: Date.now() });
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches('input,select,textarea')) return;
    const value = el.type === 'password' ? '<SECRET>' : el.value;
    const locators = buildLocators(el);
    toBuffer({ kind: 'fill', label: labelText(el) || el.name, value: QA_MASK.mask(String(value)), locator: locators[0] });
    if (recording) sendStep({ action: 'fill', locators, value, t: Date.now() });
  }, true);

  // הודעות שנתפסו ב-MAIN world (console / exceptions) מועברות לרקע
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__qa) return;
    const { __qa, ...item } = e.data;
    toBuffer(item);
  });

  // ---------- נקודת כניסה להודעות מה-popup ----------
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === 'scan') { respond(scan()); return; }
    if (msg.type === 'record') { recording = !!msg.on; respond({ ok: true }); return; }
    if (msg.type === 'checkFields') {
      checkFields(msg.cases).then(respond);
      return true;
    }
    if (msg.type === 'runSteps') {
      runSteps(msg.steps, msg).then(respond);
      return true;
    }
  });
})();
