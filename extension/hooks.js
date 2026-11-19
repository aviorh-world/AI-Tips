// hooks.js — נטען ב-MAIN world כדי לתפוס console ו-exceptions של הדף עצמו.
// מתקינים רק פעם אחת לכל דף. מה שנתפס לפני ההתקנה לא ייתפס.
(() => {
  if (window.__qaHooked) return;
  window.__qaHooked = true;

  const post = (item) => window.postMessage({ __qa: true, ...item }, '*');
  const str = (args) => args.map((a) => {
    try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
  }).join(' ').slice(0, 500);

  const origError = console.error;
  const origWarn = console.warn;

  console.error = function (...args) {
    post({ kind: 'console', level: 'error', msg: str(args) });
    return origError.apply(this, args);
  };
  console.warn = function (...args) {
    post({ kind: 'console', level: 'warn', msg: str(args) });
    return origWarn.apply(this, args);
  };

  window.addEventListener('error', (e) => {
    post({ kind: 'exception', msg: String(e.message).slice(0, 500), src: String(e.filename || '').split('?')[0] });
  });
  window.addEventListener('unhandledrejection', (e) => {
    post({ kind: 'exception', msg: ('unhandled: ' + String(e.reason)).slice(0, 400) });
  });
})();
