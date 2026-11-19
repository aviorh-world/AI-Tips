// mask.js — מסווה ערכים רגישים. נטען גם ב-content script וגם ב-service worker.
// כל פלט שיוצא מהתוסף (AI, סיכום, דוח באג, העתקה) עובר כאן קודם.
const QA_MASK = (() => {
  const rules = [
    { re: /\b\d{9}\b/g, repl: '[ID]' },                         // ת.ז. / מספרים בני 9 ספרות
    { re: /\b(?:\d[ -]?){13,19}\b/g, repl: '[CARD]' },          // כרטיס אשראי
    { re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, repl: '[EMAIL]' },        // מייל
    { re: /\b0\d{1,2}[- ]?\d{7}\b/g, repl: '[PHONE]' },          // טלפון ישראלי
    { re: /(Bearer\s+)[A-Za-z0-9._-]+/gi, repl: '$1[TOKEN]' }    // טוקנים בטקסט
  ];

  function mask(text) {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const r of rules) out = out.replace(r.re, r.repl);
    return out;
  }

  // מסיר query string וגם fragment: פרמטרים לרוב מכילים מזהים
  function maskUrl(u) {
    try {
      const x = new URL(u);
      return x.host + x.pathname;
    } catch {
      return '[url]';
    }
  }

  return { mask, maskUrl };
})();
