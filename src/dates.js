// =====================================================================
//  التواريخ — عرضها بالعربية، واستخراج تاريخ النشر من نص منشور فيسبوك
//
//  فيسبوك لا يعطي تاريخ النشر من الرابط (يحجب الزوار غير المسجَّلين)،
//  لكنه يعرضه دائماً كنص تحت اسم الصفحة. فنقرأه من النص الملصوق.
// =====================================================================

export const AR_MONTHS = ["كانون الثاني","شباط","آذار","نيسان","أيار","حزيران",
                          "تموز","آب","أيلول","تشرين الأول","تشرين الثاني","كانون الأول"];
export const AR_SHORT  = ["ك٢","شباط","آذار","نيسان","أيار","حزيران",
                          "تموز","آب","أيلول","ت١","ت٢","ك١"];

export const iso = (d) =>
  d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

export const todayISO = () => iso(new Date());

export function parseISO(s) {
  const p = String(s || "").split("-");
  return p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
}

export function addDays(isoStr, n) {
  const d = parseISO(isoStr);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  return iso(d);
}

export function fmtDate(s) {
  const d = parseISO(s);
  return d ? `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}` : (s || "");
}

export function fmtShort(s) {
  const d = parseISO(s);
  return d ? `${d.getDate()}/${d.getMonth() + 1}` : (s || "");
}

export function monthBounds(offset = 0) {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth() + offset, 1);
  return {
    from: iso(d),
    to: iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
    label: `${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  };
}

// ---------------------------------------------------------------------
//  قارئ التاريخ
// ---------------------------------------------------------------------
const AR_DIG = { "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
                 "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9" };

export const normDigits = (s) =>
  String(s == null ? "" : s).replace(/[٠-٩۰-۹]/g, (d) => AR_DIG[d] || d);

// أسماء الشهور: شامية ومصرية وإنكليزية — منشورات المديريات تستعمل الثلاثة
const MONTH_WORDS = [
  ["كانون الثاني", "يناير", "january", "jan"],
  ["شباط", "فبراير", "february", "feb"],
  ["آذار", "اذار", "مارس", "march", "mar"],
  ["نيسان", "أبريل", "إبريل", "ابريل", "april", "apr"],
  ["أيار", "ايار", "مايو", "may"],
  ["حزيران", "يونيو", "يونيه", "june", "jun"],
  ["تموز", "يوليو", "يوليه", "july", "jul"],
  ["آب", "أغسطس", "اغسطس", "august", "aug"],
  ["أيلول", "ايلول", "سبتمبر", "september", "sept", "sep"],
  ["تشرين الأول", "تشرين الاول", "أكتوبر", "اكتوبر", "october", "oct"],
  ["تشرين الثاني", "نوفمبر", "november", "nov"],
  ["كانون الأول", "كانون الاول", "ديسمبر", "december", "dec"],
];

const monthIndexOf = (w) => MONTH_WORDS.findIndex((list) => list.includes(w));

function mkISO(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const dt = new Date(y, m - 1, d);
  return dt.getMonth() === m - 1 && dt.getDate() === d ? iso(dt) : null;
}

// شهر بلا سنة: إن وقع في المستقبل فهو من السنة الماضية، لا القادمة
function noFuture(y, m, d) {
  const v = mkISO(y, m, d);
  if (!v) return null;
  return v > addDays(todayISO(), 2) ? mkISO(y - 1, m, d) : v;
}

export function findDateInText(raw) {
  const t = normDigits(raw).toLowerCase();
  if (!t.trim()) return null;
  let m;

  // 2026-09-09
  if ((m = t.match(/(?:^|\D)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/)))
    return mkISO(+m[1], +m[2], +m[3]);

  // 9/9/2026 — يوم/شهر/سنة، مع تسامح لو جاءت شهر/يوم/سنة
  if ((m = t.match(/(?:^|\D)(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})(?:\D|$)/))) {
    let d = +m[1], mo = +m[2];
    if (mo > 12 && d <= 12) { const x = d; d = mo; mo = x; }
    return mkISO(+m[3], mo, d);
  }

  const ALL = MONTH_WORDS.flat()
    .sort((a, b) => b.length - a.length)             // "september" قبل "sep"
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  try {
    // ٩ أيلول ٢٠٢٦ — الحدّ (?![\p{L}]) يمنع مطابقة «آب» داخل «آبار»
    let re = new RegExp(`(?:^|[^\\p{L}\\d])(\\d{1,2})\\s*(?:من\\s+)?(${ALL})(?![\\p{L}])(?:\\s*,?\\s*(20\\d{2}))?`, "u");
    if ((m = t.match(re))) {
      const i = monthIndexOf(m[2]);
      if (i > -1) return m[3] ? mkISO(+m[3], i + 1, +m[1]) : noFuture(new Date().getFullYear(), i + 1, +m[1]);
    }
    // September 1, 2026
    re = new RegExp(`(?:^|[^\\p{L}\\d])(${ALL})(?![\\p{L}])\\s+(\\d{1,2})(?:\\s*,?\\s*(20\\d{2}))?`, "u");
    if ((m = t.match(re))) {
      const i = monthIndexOf(m[1]);
      if (i > -1) return m[3] ? mkISO(+m[3], i + 1, +m[2]) : noFuture(new Date().getFullYear(), i + 1, +m[2]);
    }
  } catch { /* متصفح قديم لا يدعم \p{L} — نكمل إلى الصيغ النسبية */ }

  // الصيغ النسبية التي يعرضها فيسبوك
  if (/(?:أول|اول)\s*(?:أمس|امس|مبارح)/.test(t)) return addDays(todayISO(), -2);
  if (/(?:^|\W)(?:أمس|امس|مبارح|yesterday)(?:\W|$)/.test(t)) return addDays(todayISO(), -1);
  if ((m = t.match(/(?:منذ|قبل)\s*(\d+)\s*(?:يوم|أيام|ايام)/))) return addDays(todayISO(), -(+m[1]));
  if ((m = t.match(/(?:منذ|قبل)\s*(\d+)\s*(?:أسبوع|اسبوع|أسابيع|اسابيع)/))) return addDays(todayISO(), -7 * (+m[1]));
  if (/(?:منذ|قبل)\s*\d+\s*(?:دقيقة|دقائق|دقيقه|ساعة|ساعات|ساعه)/.test(t)) return todayISO();
  if ((m = t.match(/(?:^|\W)(\d{1,2})\s*d(?:ays?)?\s*(?:ago)?(?:\W|$)/))) return addDays(todayISO(), -(+m[1]));
  if ((m = t.match(/(?:^|\W)(\d{1,2})\s*w(?:eeks?)?\s*(?:ago)?(?:\W|$)/))) return addDays(todayISO(), -7 * (+m[1]));
  if (/(?:^|\W)\d{1,2}\s*h(?:rs?|ours?)?\s*(?:ago)?(?:\W|$)/.test(t)) return todayISO();
  if (/(?:^|\W)(?:اليوم|today)(?:\W|$)/.test(t)) return todayISO();

  return null;
}

// ---------------------------------------------------------------------
//  مسوّدة عنوان من نص المنشور — تنظيف لا ذكاء اصطناعي، تعمل بلا إنترنت
// ---------------------------------------------------------------------
export function draftTitle(caption) {
  let t = String(caption || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/#[^\s#]+/g, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")
    .replace(/^\s*(?:مديرية[^\n،.]*|Quneitra[^\n]*)[·|\-–—]\s*/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";

  // أول جملة كاملة، وإلا أول ٨٠ حرفاً عند آخر مسافة
  const cut = t.search(/[.!؟?\n]/);
  if (cut > 12) t = t.slice(0, cut);
  if (t.length > 80) {
    const sp = t.lastIndexOf(" ", 80);
    t = t.slice(0, sp > 40 ? sp : 80);
  }
  return t.replace(/[،,\-–—:;\s]+$/, "").trim();
}
