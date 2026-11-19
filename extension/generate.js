// generate.js — יצירת מקרי גבול דטרמיניסטיים לפי סוג השדה. נטען ב-popup.
// לא דורש AI. מקרים שמגיעים מה-AI עוברים אותו אימות ואישור בדיוק כמו אלה.
function casesFor(field) {
  const cases = [];
  const label = field.label || field.name || field.tag;
  const add = (name, value, expect) => cases.push({
    field: label,
    name,
    value,
    expect,
    locators: field.locators,
    source: 'deterministic',
    approved: false
  });

  if (field.required) add('שדה חובה — ריק', '', 'error');

  const t = field.inputType;
  if (t === 'email') {
    add('מייל תקין', 'test@example.com', 'ok');
    add('מייל בלי @', 'testexample.com', 'error');
  } else if (t === 'number') {
    if (field.min !== null) add('מתחת למינימום', String(Number(field.min) - 1), 'error');
    if (field.max !== null) add('מעל המקסימום', String(Number(field.max) + 1), 'error');
    add('מספר תקין', '1', 'ok');
    add('טקסט במקום מספר', 'אבג', 'error');
  } else if (t === 'date') {
    add('תאריך תקין', '2026-06-15', 'ok');
    add('תאריך לא קיים', '2026-02-31', 'error');
  } else if (t === 'tel') {
    add('טלפון תקין', '0501234567', 'any');
  } else if (t === 'checkbox' || t === 'radio' || field.tag === 'select') {
    add('בחירה כלשהי', '', 'any');
  } else {
    const len = field.maxlength || 50;
    add('טקסט בתוך הגבול', 'א'.repeat(Math.min(len, 20)), 'ok');
    add('תווים מיוחדים', '<>"\'&', 'any');
  }

  return cases;
}

function casesForAll(fields) {
  return fields
    .filter((f) => f.tag === 'input' || f.tag === 'textarea' || f.tag === 'select')
    .flatMap(casesFor);
}
