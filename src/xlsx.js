// =====================================================================
//  مُصدِّر Excel
//
//  لا ننشئ ملفاً جديداً ونحاول تقليد القالب — نفتح قالب المديرية نفسه
//  ونستبدل صفوف البيانات فقط. فيبقى الجدول والأنماط والتعبئة الصفراء
//  واتجاه اليمين-لليسار كما هي حرفياً، لأنها لم تُمَس.
//
//  أرقام الأنماط (s="..") مأخوذة من القالب الأصلي:
//    الترويسة B1:I1 = 8, 9, 9, 2, 2, 2, 2, 26
//    صف البيانات   = 1, 1, 1, 16, 17, 41, 18, 23
//    ملخص الإنجاز  = 68 (العنوان المدموج), 13 (رؤوس), 2 (القيم)
// =====================================================================

import { TEMPLATE_B64 } from "../vendor/template.b64.js";

const HEAD = { B: 8, C: 9, D: 9, E: 2, F: 2, G: 2, H: 2, I: 26 };
const DATA = { B: 1, C: 1, D: 1, E: 16, F: 17, G: 41, H: 18, I: 23 };

const xesc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Excel يعدّ الأيام منذ 1899-12-30
function dateSerial(isoStr) {
  const p = String(isoStr || "").split("-");
  if (p.length !== 3) return null;
  const ms = Date.UTC(+p[0], +p[1] - 1, +p[2]);
  return Number.isNaN(ms) ? null : Math.round(ms / 86400000) + 25569;
}

const cellText = (ref, s, txt) =>
  txt == null || txt === ""
    ? `<c r="${ref}" s="${s}"/>`
    : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xesc(txt)}</t></is></c>`;

const cellNum = (ref, s, n) =>
  n == null || n === "" ? `<c r="${ref}" s="${s}"/>` : `<c r="${ref}" s="${s}"><v>${n}</v></c>`;

function buildSheetData(rows, meta) {
  const out = [], hyperlinks = [], rels = [];
  let hid = 0;

  out.push(
    '<row r="1" spans="2:12" ht="36" customHeight="1">' +
      cellText("B1", HEAD.B, "م") + cellText("C1", HEAD.C, "الأسم") +
      cellText("D1", HEAD.D, "المديرية الفرعية") + cellText("E1", HEAD.E, "عنوان المادة") +
      cellText("F1", HEAD.F, "التاريخ") + cellText("G1", HEAD.G, "الرابط") +
      cellText("H1", HEAD.H, "الملاحظات") + cellText("I1", HEAD.I, "عمود1") +
      cellText("J1", 68, "ملخص الإنجاز") + '<c r="K1" s="68"/><c r="L1" s="68"/></row>',
  );

  const n = rows.length;
  const last = Math.max(n + 1, 3); // الورقة تحتفظ بصفوف الملخص الثلاثة دائماً

  for (let i = 0; i < last - 1; i++) {
    const r = i + 2, d = rows[i], c = [];

    if (d) {
      c.push(cellNum(`B${r}`, DATA.B, i + 1));
      c.push(cellText(`C${r}`, DATA.C, d.name || meta.name));
      c.push(cellText(`D${r}`, DATA.D, d.directorate || meta.directorate));
      c.push(cellText(`E${r}`, DATA.E, d.title));
      const ser = dateSerial(d.date);
      c.push(ser != null ? cellNum(`F${r}`, DATA.F, ser) : cellText(`F${r}`, DATA.F, d.date));
      c.push(cellText(`G${r}`, DATA.G, d.link));
      c.push(cellText(`H${r}`, DATA.H, d.notes));
      c.push(cellText(`I${r}`, DATA.I, d.extra));

      if (d.link) {
        hid++;
        hyperlinks.push(`<hyperlink ref="G${r}" r:id="rIdH${hid}"/>`);
        rels.push(
          `<Relationship Id="rIdH${hid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xesc(d.link)}" TargetMode="External"/>`,
        );
      }
    } else {
      c.push(
        `<c r="B${r}" s="${DATA.B}"/><c r="C${r}" s="${DATA.C}"/><c r="D${r}" s="${DATA.D}"/>` +
        `<c r="E${r}" s="${DATA.E}"/><c r="F${r}" s="${DATA.F}"/><c r="G${r}" s="${DATA.G}"/>` +
        `<c r="H${r}" s="${DATA.H}"/><c r="I${r}" s="${DATA.I}"/>`,
      );
    }

    if (r === 2) c.push(cellText("J2", 13, "الاسم") + cellText("K2", 13, "القسم") + cellText("L2", 13, "عدد المواد "));
    else if (r === 3) c.push(cellText("J3", 2, meta.name) + cellText("K3", 2, meta.section) + cellNum("L3", 2, n));

    out.push(`<row r="${r}" spans="2:12" ht="30" customHeight="1">${c.join("")}</row>`);
  }

  return { rows: out.join(""), last, hyperlinks: hyperlinks.join(""), rels: rels.join("") };
}

/**
 * @param {Array<{name,directorate,title,date,link,notes,extra}>} rows
 * @param {{name:string, directorate:string, section:string}} meta
 * @returns {Promise<Blob>} ملف .xlsx جاهز
 */
export async function buildWorkbook(rows, meta) {
  const zip = await window.JSZip.loadAsync(TEMPLATE_B64, { base64: true });
  const built = buildSheetData(rows, meta);

  let sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
  sheet = sheet
    .replace("<sheetData/>", `<sheetData>${built.rows}</sheetData>`)
    .replace("__DIM__", `B1:L${built.last}`);
  if (built.hyperlinks) {
    sheet = sheet.replace("<pageMargins", `<hyperlinks>${built.hyperlinks}</hyperlinks><pageMargins`);
  }
  zip.file("xl/worksheets/sheet1.xml", sheet);

  const table = await zip.file("xl/tables/table1.xml").async("string");
  zip.file("xl/tables/table1.xml", table.replace(/__TREF__/g, `B1:I${built.last}`));

  const rels = await zip.file("xl/worksheets/_rels/sheet1.xml.rels").async("string");
  zip.file("xl/worksheets/_rels/sheet1.xml.rels", rels.replace("__HLRELS__", built.rels));

  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
