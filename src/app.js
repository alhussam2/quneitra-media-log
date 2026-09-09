// =====================================================================
//  سجل مواد القنيطرة — الواجهة
//
//  ما تراه هنا من إخفاء أزرار وتصفية قوائم هو راحة استعمال فقط.
//  المنع الحقيقي في سياسات RLS داخل Postgres (supabase/migrations).
// =====================================================================

import { ORG, isConfigured } from "./config.js";
import * as api from "./api.js";
import { buildWorkbook, downloadBlob } from "./xlsx.js";
import {
  AR_MONTHS, AR_SHORT, iso, todayISO, parseISO, addDays,
  fmtDate, fmtShort, monthBounds, findDateInText, draftTitle, normDigits,
} from "./dates.js";

const $ = (s) => document.querySelector(s);

/* ------------------------------ الحالة ------------------------------ */
const state = {
  me: null,
  entries: [],
  profiles: [],
  reports: {},              // scope -> صف آخر تقرير
  editingId: null,
  listRange: "month",
  listOwner: "_all",
  reportOwner: "_all",
  reportPreset: "month",
  dateTouched: false,
};

const isAdmin = () => state.me?.role === "admin";
const may = (perm) => !!state.me && (isAdmin() || !!state.me[perm]);

/* ----------------------------- أدوات صغيرة -------------------------- */
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const plural = (n) =>
  n === 1 ? "مادة واحدة" : n === 2 ? "مادتان" : (n >= 3 && n <= 10) ? `${n} مواد` : `${n} مادة`;

let toastTimer;
function toast(msg, kind) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (kind ? ` ${kind}` : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
}

function cleanUrl(u) {
  if (!u) return "";
  const s = u.trim();
  try {
    const url = new URL(s);
    [...url.searchParams.keys()]
      .filter((k) => k.startsWith("__") ||
        ["fbclid", "mibextid", "rdid", "share_url", "idorvanity", "extid"].includes(k))
      .forEach((k) => url.searchParams.delete(k));
    return url.toString();
  } catch { return s; }
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

const URL_RE = /https?:\/\/[^\s؀-ۿ]+/g;


/* --------------------------- مدة الفيديو ---------------------------
   تُحفظ داخل الملاحظات بصيغة ثابتة، فتظهر في عمود «الملاحظات» بملف
   Excel كما اعتاد المستخدم أن يكتبها بيده. تقبل 13:42 أو ١٣:٤٢ أو
   عدد ثوانٍ خاماً (822 → 13:42). */
const DUR_LABEL = "مدة المادة";

function normDuration(v) {
  const raw = normDigits(String(v || "").trim()).replace(/[.,]/g, ":");
  if (!raw) return "";
  if (/^\d+$/.test(raw)) {                     // ثوانٍ خام
    const n = +raw;
    return n >= 60
      ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`
      : `0:${String(n).padStart(2, "0")}`;
  }
  const p = raw.split(":").map((x) => x.trim()).filter(Boolean).map(Number);
  if (p.some(Number.isNaN)) return raw;
  if (p.length === 2) return `${p[0]}:${String(p[1]).padStart(2, "0")}`;
  if (p.length === 3) return `${p[0]}:${String(p[1]).padStart(2, "0")}:${String(p[2]).padStart(2, "0")}`;
  return raw;
}

const joinNotes = (dur, notes) => {
  const d = normDuration(dur);
  const n = String(notes || "").trim();
  if (!d) return n;
  return n ? `${DUR_LABEL}: ${d} — ${n}` : `${DUR_LABEL}: ${d}`;
};

function splitNotes(notes) {
  const m = String(notes || "").match(/^\s*مدة المادة\s*[:：]\s*([^—\n]+?)\s*(?:—\s*([\s\S]*))?$/);
  return m ? { dur: m[1].trim(), rest: (m[2] || "").trim() } : { dur: "", rest: String(notes || "") };
}

/* --------------------------- نطاقات التواريخ ------------------------ */
function rangeFor(kind) {
  if (kind === "month") return monthBounds(0);
  if (kind === "prev") return monthBounds(-1);
  if (kind === "since") {
    const last = state.reports[reportScope()];
    const start = last?.to_date ? addDays(last.to_date, 1) : null;
    return { from: start || "", to: todayISO(), label: start ? "منذ آخر تقرير" : "كل المواد حتى اليوم" };
  }
  return { from: "", to: "", label: "كل المواد" };
}
const inRange = (e, from, to) =>
  !(from && String(e.date) < from) && !(to && String(e.date) > to);

const reportScope = () => (isAdmin() ? state.reportOwner : "own");

/* ------------------------------ التصفية ----------------------------- */
function byOwner(list, owner) {
  return owner === "_all" ? list : list.filter((e) => e.owner_username === owner);
}
const ownerLabel = (u) =>
  u === "_all" ? "كل الموظفين"
    : (state.profiles.find((p) => p.username === u)?.full_name
       || state.entries.find((e) => e.owner_username === u)?.name
       || u);

/** كل من له مواد أو حساب — يشمل من حُذف حسابه، فإنجازه محفوظ. */
function ownerOptions() {
  const seen = new Map();
  state.profiles.forEach((p) => seen.set(p.username, p.full_name));
  state.entries.forEach((e) => { if (!seen.has(e.owner_username)) seen.set(e.owner_username, `${e.name} (حساب محذوف)`); });
  return [...seen.entries()];
}

function fillOwnerSelect(el, selected) {
  el.innerHTML = `<option value="_all">كل الموظفين</option>` +
    ownerOptions().map(([u, n]) => `<option value="${esc(u)}">${esc(n)}</option>`).join("");
  el.value = selected;
}

/* =====================================================================
   العرض
   ===================================================================== */
function renderStrip() {
  const { from, to, label } = monthBounds(0);
  const days = parseISO(to).getDate();
  const t = todayISO();
  const mine = byOwner(state.entries, isAdmin() ? state.listOwner : "_all");
  const counts = {};
  mine.forEach((e) => { if (inRange(e, from, to)) counts[e.date] = (counts[e.date] || 0) + 1; });

  let h = "";
  for (let i = 1; i <= days; i++) {
    const d = from.slice(0, 8) + String(i).padStart(2, "0");
    const c = counts[d] || 0;
    h += `<span class="day${c ? " has" : ""}${d === t ? " today" : ""}" title="${i} ${esc(label)} — ${plural(c)}"></span>`;
  }
  $("#strip").innerHTML = h;
  $("#stripLabel").textContent = `إنتاج ${label}`;
  $("#stripCount").textContent = plural(Object.values(counts).reduce((a, b) => a + b, 0));
}

function renderReminder() {
  const scope = reportScope();
  const last = state.reports[scope];
  const who = isAdmin() && scope !== "own"
    ? ` (${ownerLabel(scope === "_all" ? "_all" : scope)})` : "";
  let body;

  if (last?.to_date) {
    const pool = byOwner(state.entries, isAdmin() ? state.reportOwner : "_all");
    const after = pool.filter((e) => String(e.date) > last.to_date).length;
    body = `<span class="rlabel">آخِر تقرير صدّرته${esc(who)}</span>`
      + `من <time>${esc(fmtDate(last.from_date || "—"))}</time> إلى <time>${esc(fmtDate(last.to_date))}</time>`
      + ` <span style="color:var(--ink-3)">— بتاريخ ${esc(fmtDate(last.exported_at.slice(0, 10)))}</span><br>`
      + (after ? `بعده <strong>${plural(after)}</strong> بدون تقرير.` : "ما في مواد جديدة بعده.");
  } else {
    body = `<span class="rlabel">تذكير</span>`
      + `لسّا ما صدّرت أي تقرير${esc(who)}. أول تقرير رح ينحفظ تاريخه هون حتى تعرف من وين تكمّل المرة الجاي.`;
  }

  $("#reminderSlot").innerHTML =
    `<div class="reminder"><div class="rtxt">${body}</div>` +
    `<button type="button" id="nextReportBtn">${last?.to_date ? "التقرير التالي" : "جهّز تقرير"}</button></div>`;

  $("#nextReportBtn").addEventListener("click", () => {
    setView("report");
    setPreset(state.reports[reportScope()]?.to_date ? "since" : "month");
  });
}

function entryHTML(e) {
  const d = parseISO(e.date);
  const rail = d
    ? `<span class="d">${d.getDate()}</span><span class="m">${AR_SHORT[d.getMonth()]}</span><span class="y">${d.getFullYear()}</span>`
    : `<span class="m">بلا تاريخ</span>`;

  const meta = [];
  if (isAdmin()) meta.push(`<span class="pill muted">${esc(e.name)}</span>`);
  if (e.extra) meta.push(`<span>${esc(e.extra)}</span>`);
  if (e.link) meta.push(`<a href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(e.link) || e.link)}</a>`);
  else meta.push(`<span style="color:var(--red)">بدون رابط</span>`);

  const editable = isAdmin() || (e.owner_id === state.me.id && may("can_edit_own"));
  const acts = editable ? `<div class="eacts">
      <button class="mini act-edit" title="تعديل" aria-label="تعديل"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
      <button class="mini del act-del" title="حذف" aria-label="حذف"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>
    </div>` : "";

  return `<li class="entry" data-id="${esc(e.id)}">
    <div class="rail">${rail}</div>
    <div class="ebody">
      <p class="etitle">${esc(e.title || "(بدون عنوان)")}</p>
      ${meta.length ? `<div class="emeta">${meta.join("")}</div>` : ""}
      ${e.notes ? `<div class="enote">${esc(e.notes)}</div>` : ""}
    </div>${acts}</li>`;
}

function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const r = rangeFor(state.listRange);
  let rows = byOwner(state.entries, isAdmin() ? state.listOwner : "_all")
    .filter((e) => inRange(e, r.from, r.to));
  if (q) {
    rows = rows.filter((e) =>
      `${e.title} ${e.notes} ${e.link} ${e.extra} ${e.name}`.toLowerCase().includes(q));
  }
  rows = rows.slice().reverse();

  $("#listRangeLabel").textContent = r.label + (isAdmin() && state.listOwner !== "_all" ? ` — ${ownerLabel(state.listOwner)}` : "");
  $("#listCount").textContent = plural(rows.length);
  $("#entries").innerHTML = rows.length
    ? rows.map(entryHTML).join("")
    : `<div class="empty"><b>${q ? "ما في نتيجة" : "ما في مواد بهالفترة"}</b>${q ? "جرّب كلمة تانية." : "سجّل أول مادة من تبويب «تسجيل»."}</div>`;
}

const reportRows = () =>
  byOwner(state.entries, isAdmin() ? state.reportOwner : "_all")
    .filter((e) => inRange(e, $("#rFrom").value, $("#rTo").value));

function renderReport() {
  const rows = reportRows();
  const from = $("#rFrom").value, to = $("#rTo").value;
  $("#rCount").textContent = rows.length;
  $("#rRangeText").textContent = (from || to)
    ? `${from ? fmtDate(from) : "البداية"} ← ${to ? fmtDate(to) : "اليوم"}`
    : "كل المواد المسجّلة";

  const show = rows.slice(0, 6);
  $("#rPreview").innerHTML = rows.length
    ? show.map((e) => `<li><span class="pdate">${esc(fmtShort(e.date))}</span><span class="ptitle">${esc(e.title || "(بدون عنوان)")}</span></li>`).join("")
      + (rows.length > show.length ? `<li class="more">و${plural(rows.length - show.length)} غيرها في الملف.</li>` : "")
    : `<li class="more">ما في مواد بهالفترة — عدّل التواريخ.</li>`;

  const allowed = may("can_export");
  $("#exportBtn").hidden = !allowed;
  $("#exportDenied").hidden = allowed;
  $("#exportBtn").disabled = rows.length === 0;
}

function renderUsers() {
  if (!isAdmin()) return;
  $("#usersList").innerHTML = state.profiles.map((p) => {
    const count = state.entries.filter((e) => e.owner_username === p.username).length;
    const perms = [
      p.role === "admin" ? null : (p.can_add ? "يضيف" : null),
      p.role === "admin" ? null : (p.can_edit_own ? "يعدّل" : null),
      p.role === "admin" ? null : (p.can_export ? "يصدّر" : null),
    ].filter(Boolean).join(" · ") || (p.role === "admin" ? "كل الصلاحيات" : "بلا صلاحيات");

    return `<li class="user${p.active ? "" : " off"}" data-id="${esc(p.id)}" data-username="${esc(p.username)}">
      <div class="user-top">
        <b>${esc(p.full_name)}</b>
        ${p.role === "admin" ? '<span class="pill">أدمن</span>' : ""}
        ${p.active ? "" : '<span class="pill muted">معطَّل</span>'}
      </div>
      <div class="user-meta">
        <span class="mono">${esc(p.username)}</span>
        <span>${perms}</span>
        <span>${plural(count)}</span>
      </div>
      <div class="user-acts">
        <button class="btn btn-quiet act-perms">الصلاحيات</button>
        <button class="btn btn-quiet act-pw">كلمة سر جديدة</button>
        <button class="btn btn-quiet act-toggle">${p.active ? "تعطيل" : "تفعيل"}</button>
        ${p.id === state.me.id ? "" : '<button class="btn btn-quiet warn act-del">حذف</button>'}
      </div></li>`;
  }).join("") || `<div class="empty"><b>ما في حسابات بعد</b>أنشئ حساب الموظف الأول من الفورم فوق.</div>`;
}

function renderMe() {
  const m = state.me;
  $("#meName").textContent = m.full_name;
  $("#meRole").hidden = m.role !== "admin";
  $("#sName").textContent = m.full_name;
  $("#sUser").textContent = m.username;
  $("#sRole").textContent = m.role === "admin" ? "أدمن — كل الصلاحيات"
    : [m.can_add && "إضافة", m.can_edit_own && "تعديل وحذف", m.can_export && "تصدير"]
        .filter(Boolean).join(" · ") || "قراءة فقط";
  $("#sDir").textContent = m.directorate;

  $("#tab-users").hidden = !isAdmin();
  $("#onBehalfField").hidden = !isAdmin();
  $("#listOwnerField").hidden = !isAdmin();
  $("#reportOwnerField").hidden = !isAdmin();

  const canAdd = may("can_add");
  $("#saveBtn").hidden = !canAdd;
  $("#addDenied").hidden = canAdd;

  if (isAdmin()) {
    $("#fOwner").innerHTML = state.profiles.filter((p) => p.active)
      .map((p) => `<option value="${esc(p.id)}">${esc(p.full_name)}</option>`).join("");
    $("#fOwner").value = state.me.id;
    fillOwnerSelect($("#listOwner"), state.listOwner);
    fillOwnerSelect($("#reportOwner"), state.reportOwner);
  }
}

function renderAll() {
  renderMe(); renderStrip(); renderReminder(); renderList(); renderReport(); renderUsers();
}

/* ------------------------------ التنقّل ----------------------------- */
function setView(v) {
  ["add", "list", "report", "users", "settings"].forEach((n) => {
    $(`#view-${n}`).classList.toggle("on", n === v);
    const t = $(`#tab-${n}`);
    if (t) t.setAttribute("aria-selected", String(n === v));
  });
  $("#gearBtn").setAttribute("aria-pressed", String(v === "settings"));
  window.scrollTo({ top: 0, behavior: "instant" });
}

/* =====================================================================
   نموذج التسجيل
   ===================================================================== */
const setDateSrc = (t) => { $("#dateSrc").textContent = t; };

function resetForm() {
  state.editingId = null;
  state.dateTouched = false;
  ["#dump", "#fLink", "#fTitle", "#fNotes", "#fExtra", "#fDur"].forEach((s) => { $(s).value = ""; });
  $("#fDate").value = todayISO();
  setDateSrc("تاريخ اليوم");
  $("#addHeading").textContent = "تسجيل مادة";
  $("#saveBtn").textContent = "حفظ المادة";
  $("#cancelEdit").hidden = true;
  $("#suggestRow").hidden = true;
  $("#suggestNote").textContent = "";
  $("#fetchRow").hidden = true;
  $("#fetchNote").textContent = "";
  $("#onBehalfField").hidden = !isAdmin();
  if (isAdmin()) $("#fOwner").value = state.me.id;
}

function wireForm() {
  $("#dump").addEventListener("input", (e) => {
    const txt = e.target.value;
    const urls = txt.match(URL_RE);
    if (urls && !$("#fLink").value) $("#fLink").value = cleanUrl(urls[0]);

    const caption = txt.replace(URL_RE, " ").replace(/\s+/g, " ").trim();
    $("#suggestRow").hidden = caption.length < 20;

    if (!state.dateTouched) {
      const found = findDateInText(caption);
      if (found) { $("#fDate").value = found; setDateSrc("من نص المنشور"); }
      else { $("#fDate").value = todayISO(); setDateSrc(caption ? "ما لقيت تاريخ بالنص — اليوم" : "تاريخ اليوم"); }
    }
  });

  $("#suggestBtn").addEventListener("click", () => {
    const caption = $("#dump").value.replace(URL_RE, " ").replace(/\s+/g, " ").trim();
    const t = draftTitle(caption);
    if (!t) { $("#suggestNote").textContent = "ما قدرت أطلّع عنوان من هالنص."; return; }
    $("#fTitle").value = t;
    $("#suggestNote").textContent = "مسوّدة — رتّبها متل ما بدك.";
  });

  const showFetch = () => {
    const v = $("#fLink").value.trim();
    $("#fetchRow").hidden = !/facebook\.com|fb\.watch|fb\.me/i.test(v);
  };
  $("#fLink").addEventListener("input", showFetch);
  $("#fLink").addEventListener("blur", (e) => { e.target.value = cleanUrl(e.target.value); showFetch(); });

  $("#fetchBtn").addEventListener("click", async () => {
    const url = cleanUrl($("#fLink").value);
    if (!url) return;
    const btn = $("#fetchBtn"), note = $("#fetchNote");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "جارٍ القراءة…";
    note.textContent = "";
    try {
      const r = await api.lookupFacebook(url);
      const got = [];

      if (r.title && !$("#fTitle").value.trim()) { $("#fTitle").value = r.title; got.push("العنوان"); }
      else if (r.title) { $("#fTitle").value = r.title; got.push("العنوان"); }

      if (r.date) { $("#fDate").value = r.date; state.dateTouched = true; setDateSrc("من فيسبوك"); got.push("التاريخ"); }
      if (r.duration) { $("#fDur").value = r.duration; got.push("المدة"); }

      note.textContent = got.length
        ? (r.hasToken ? `جاب ${got.join(" و")}.` : `جاب ${got.join(" و")}. التاريخ والمدة بدهن توكن الصفحة.`)
        : "ما لقيت بيانات بهالرابط.";
      if (r.graphError) note.textContent += " (توكن الصفحة ما اشتغل.)";
      if (r.fetchError) note.textContent += ` [${r.fetchError}]`;
    } catch (err) {
      note.textContent = err.message || "ما زبطت القراءة.";
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  $("#fDate").addEventListener("change", () => { state.dateTouched = true; setDateSrc("حدّدته بإيدك"); });
  $("#dateChips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    const off = +b.dataset.day;
    $("#fDate").value = addDays(todayISO(), off);
    state.dateTouched = true;
    setDateSrc(off === 0 ? "تاريخ اليوم" : "أمس");
  });
  $("#cancelEdit").addEventListener("click", () => { resetForm(); setView("list"); });

  $("#saveBtn").addEventListener("click", async () => {
    const title = $("#fTitle").value.trim();
    const link = cleanUrl($("#fLink").value);
    if (!title && !link) { toast("لازم عنوان أو رابط على الأقل", "err"); $("#fTitle").focus(); return; }

    const payload = {
      title, link,
      date: $("#fDate").value || todayISO(),
      notes: joinNotes($("#fDur").value, $("#fNotes").value),
      extra: $("#fExtra").value.trim(),
    };

    const dup = state.entries.find((e) => link && e.link === link && e.id !== state.editingId);
    if (dup && !confirm(`هالرابط مسجّل من قبل بتاريخ ${fmtDate(dup.date)}.\nبدك تسجّله كمان مرة؟`)) return;

    const btn = $("#saveBtn");
    btn.disabled = true;
    try {
      if (state.editingId) {
        const updated = await api.updateEntry(state.editingId, payload);
        const i = state.entries.findIndex((e) => e.id === state.editingId);
        if (i > -1) state.entries[i] = updated;
        toast("تم التعديل", "ok");
      } else {
        const ownerId = isAdmin() ? $("#fOwner").value : state.me.id;
        const owner = state.profiles.find((p) => p.id === ownerId) || state.me;
        state.entries.push(await api.createEntry(payload, owner));
        toast("تسجّلت المادة", "ok");
      }
      sortEntries();
      resetForm();
      renderAll();
    } catch (err) {
      toast(errText(err, "ما انحفظت المادة"), "err");
    } finally { btn.disabled = false; }
  });

  $("#entries").addEventListener("click", async (ev) => {
    const li = ev.target.closest(".entry"); if (!li) return;
    const e = state.entries.find((x) => x.id === li.dataset.id); if (!e) return;

    if (ev.target.closest(".act-edit")) {
      state.editingId = e.id;
      $("#fTitle").value = e.title || "";
      $("#fLink").value = e.link || "";
      $("#fDate").value = e.date || todayISO();
      const parts = splitNotes(e.notes);
      $("#fDur").value = parts.dur;
      $("#fNotes").value = parts.rest;
      $("#fExtra").value = e.extra || "";
      $("#dump").value = "";
      state.dateTouched = true;
      setDateSrc("تاريخ المادة المسجّلة");
      $("#addHeading").textContent = "تعديل مادة";
      $("#saveBtn").textContent = "حفظ التعديل";
      $("#cancelEdit").hidden = false;
      $("#suggestRow").hidden = true;
      $("#onBehalfField").hidden = true;   // المالك لا يتغيّر بالتعديل
      setView("add");
    } else if (ev.target.closest(".act-del")) {
      if (!confirm(`حذف "${e.title || "هذه المادة"}"؟`)) return;
      try {
        await api.deleteEntry(e.id);
        state.entries = state.entries.filter((x) => x.id !== e.id);
        renderAll();
        toast("انحذفت");
      } catch (err) { toast(errText(err, "ما انحذفت"), "err"); }
    }
  });
}

const sortEntries = () =>
  state.entries.sort((a, b) =>
    a.date === b.date ? String(a.created_at).localeCompare(String(b.created_at))
                      : String(a.date).localeCompare(String(b.date)));

/* =====================================================================
   القائمة والتقارير
   ===================================================================== */
function wireListAndReport() {
  $("#search").addEventListener("input", renderList);

  $("#listChips").addEventListener("click", (e) => {
    const c = e.target.closest(".chip"); if (!c) return;
    state.listRange = c.dataset.range;
    $("#listChips").querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
    renderList();
  });

  $("#listOwner").addEventListener("change", (e) => {
    state.listOwner = e.target.value;
    renderStrip(); renderList();
  });

  $("#reportOwner").addEventListener("change", (e) => {
    state.reportOwner = e.target.value;
    renderReminder(); setPreset(state.reportPreset);
  });

  $("#reportChips").addEventListener("click", (e) => {
    const c = e.target.closest(".chip"); if (!c) return;
    setPreset(c.dataset.preset);
  });

  const manual = () => {
    $("#reportChips").querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", "false"));
    renderReport();
  };
  $("#rFrom").addEventListener("change", manual);
  $("#rTo").addEventListener("change", manual);

  $("#exportBtn").addEventListener("click", doExport);
}

function setPreset(kind) {
  state.reportPreset = kind;
  const r = rangeFor(kind);
  $("#rFrom").value = r.from || "";
  $("#rTo").value = r.to || "";
  $("#reportChips").querySelectorAll(".chip")
    .forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.preset === kind)));
  renderReport();
}

async function doExport() {
  const rows = reportRows();
  if (!rows.length) return;

  const btn = $("#exportBtn");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "جارٍ تجهيز الملف…";

  const from = $("#rFrom").value || rows[0].date;
  const to = $("#rTo").value || rows[rows.length - 1].date;
  const scope = reportScope();
  const who = isAdmin() ? ownerLabel(state.reportOwner) : state.me.full_name;

  try {
    const blob = await buildWorkbook(rows, {
      name: who,
      directorate: state.me.directorate || ORG.directorate,
      section: state.me.section || ORG.section,
    });
    downloadBlob(blob, `تفريغ-المواد_${from}_${to}.xlsx`);

    await api.saveLastReport(state.me.id, scope, from, to, rows.length);
    state.reports[scope] = { from_date: from, to_date: to, item_count: rows.length, exported_at: new Date().toISOString() };
    renderReminder();
    toast(`نزّل الملف — ${plural(rows.length)}`, "ok");
  } catch (err) {
    toast(errText(err, "ما زبط التصدير"), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    renderReport();
  }
}

/* =====================================================================
   إدارة الحسابات
   ===================================================================== */
const randomPassword = () => {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint32Array(12)), (n) => abc[n % abc.length]).join("");
};

function wireUsers() {
  $("#genPass").addEventListener("click", () => { $("#nPass").value = randomPassword(); });

  $("#newUserForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("#createUserBtn");
    btn.disabled = true;
    try {
      await api.createAccount({
        full_name: $("#nName").value.trim(),
        username: $("#nUser").value.trim().toLowerCase(),
        password: $("#nPass").value,
        role: $("#nAdmin").checked ? "admin" : "member",
        can_add: $("#nAdd").checked,
        can_edit_own: $("#nEdit").checked,
        can_export: $("#nExport").checked,
        directorate: state.me.directorate,
        section: state.me.section,
      });
      const u = $("#nUser").value.trim().toLowerCase();
      const p = $("#nPass").value;
      state.profiles = await api.listProfiles();
      $("#newUserForm").reset();
      $("#nAdd").checked = $("#nEdit").checked = $("#nExport").checked = true;
      renderAll();
      alert(`تم إنشاء الحساب.\n\nاسم المستخدم: ${u}\nكلمة السر: ${p}\n\nابعتهن للموظف — كلمة السر ما رح تظهر مرة تانية.`);
    } catch (err) {
      toast(err.message || "ما زبط إنشاء الحساب", "err");
    } finally { btn.disabled = false; }
  });

  $("#usersList").addEventListener("click", async (ev) => {
    const li = ev.target.closest(".user"); if (!li) return;
    const p = state.profiles.find((x) => x.id === li.dataset.id); if (!p) return;

    try {
      if (ev.target.closest(".act-perms")) {
        const add = confirm(`${p.full_name}: يقدر يضيف مواد؟\n(موافق = نعم، إلغاء = لا)`);
        const edit = confirm(`${p.full_name}: يقدر يعدّل ويحذف مواده؟`);
        const exp = confirm(`${p.full_name}: يقدر يصدّر تقرير بمواده؟`);
        await api.updateProfile(p.id, { can_add: add, can_edit_own: edit, can_export: exp });
        state.profiles = await api.listProfiles();
        renderAll();
        toast("انحفظت الصلاحيات", "ok");

      } else if (ev.target.closest(".act-pw")) {
        const pw = prompt(`كلمة سر جديدة لـ${p.full_name} (٨ خانات فأكثر):`, randomPassword());
        if (!pw) return;
        await api.resetPassword(p.id, pw);
        alert(`تمّت. كلمة السر الجديدة لـ${p.full_name}:\n\n${pw}\n\nابعتها له.`);

      } else if (ev.target.closest(".act-toggle")) {
        await api.updateProfile(p.id, { active: !p.active });
        state.profiles = await api.listProfiles();
        renderAll();
        toast(p.active ? "انعطّل الحساب" : "انفعّل الحساب", "ok");

      } else if (ev.target.closest(".act-del")) {
        const n = state.entries.filter((e) => e.owner_username === p.username).length;
        if (!confirm(`حذف حساب ${p.full_name} نهائياً؟\n\n${plural(n)} المسجّلة باسمه بتضل محفوظة وبتشوفها إنت بالتقارير.`)) return;
        await api.deleteAccount(p.id);
        state.profiles = await api.listProfiles();
        state.entries = await api.listEntries();
        renderAll();
        toast("انحذف الحساب — المواد محفوظة", "ok");
      }
    } catch (err) {
      toast(err.message || "ما زبطت العملية", "err");
    }
  });
}

/* =====================================================================
   الإعدادات والخروج
   ===================================================================== */
function wireSettings() {
  $("#gearBtn").addEventListener("click", () =>
    setView($("#view-settings").classList.contains("on") ? "add" : "settings"));

  $("#pwForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const a = $("#pw1").value, b = $("#pw2").value;
    if (a !== b) { toast("الكلمتان مو متطابقتين", "err"); return; }
    if (a.length < 8) { toast("٨ خانات على الأقل", "err"); return; }
    try {
      await api.changeMyPassword(a);
      $("#pwForm").reset();
      toast("انحفظت كلمة السر", "ok");
    } catch (err) { toast(errText(err, "ما زبط التغيير"), "err"); }
  });

  $("#logoutBtn").addEventListener("click", async () => {
    await api.signOut();
    location.reload();
  });
}

/* =====================================================================
   الأخطاء
   ===================================================================== */
function errText(err, fallback) {
  const m = String(err?.message || "");
  if (/row-level security|violates row-level/i.test(m)) return "ما عندك صلاحية لهالعملية.";
  if (/JWT|token|session/i.test(m)) return "انتهت الجلسة — سجّل دخول من جديد.";
  if (/fetch|network|Failed to fetch/i.test(m)) return "ما في اتصال بالسيرفر.";
  return fallback;
}

/* =====================================================================
   الإقلاع
   ===================================================================== */
function showAuthError(msg) {
  const el = $("#loginErr");
  el.textContent = msg;
  el.hidden = !msg;
}

async function enterApp() {
  const me = await api.fetchMe();
  if (!me) throw new Error("no_profile");
  if (!me.active) {
    await api.signOut();
    throw new Error("disabled");
  }
  state.me = me;

  const [entries, profiles] = await Promise.all([
    api.listEntries(),
    api.listProfiles(),
  ]);
  state.entries = entries;
  state.profiles = profiles;
  sortEntries();

  const { data: reports } = await api.sb
    .from("last_reports").select("*").eq("user_id", me.id);
  state.reports = Object.fromEntries((reports || []).map((r) => [r.scope, r]));

  $("#screenAuth").hidden = true;
  $("#screenApp").hidden = false;
  resetForm();
  renderAll();
  setPreset("month");
  setView("add");
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => setView(t.dataset.view)));
}

async function boot() {
  if (!isConfigured()) {
    showAuthError("التطبيق مو مربوط بقاعدة البيانات بعد — عبّي src/config.js.");
    $("#loginBtn").disabled = true;
    return;
  }

  wireTabs(); wireForm(); wireListAndReport(); wireUsers(); wireSettings();

  $("#loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    showAuthError("");
    const btn = $("#loginBtn");
    btn.disabled = true;
    btn.textContent = "جارٍ الدخول…";
    try {
      await api.signIn($("#lUser").value, $("#lPass").value);
      await enterApp();
    } catch (err) {
      const m = String(err?.message || "");
      showAuthError(
        err.message === "disabled" ? "حسابك معطَّل — راجع الأدمن."
        : err.message === "no_profile" ? "الحساب موجود بس بلا ملف تعريف — راجع الأدمن."
        : /Invalid login/i.test(m) ? "اسم المستخدم أو كلمة السر غلط."
        : /Failed to fetch|network/i.test(m) ? "ما في اتصال بالسيرفر."
        : "ما زبط الدخول — جرّب مرة تانية.",
      );
      await api.signOut().catch(() => {});
    } finally {
      btn.disabled = false;
      btn.textContent = "دخول";
    }
  });

  // جلسة محفوظة من زيارة سابقة
  const { data: { session } } = await api.sb.auth.getSession();
  if (session) {
    try { await enterApp(); }
    catch { await api.signOut().catch(() => {}); }
  }
}

boot();
