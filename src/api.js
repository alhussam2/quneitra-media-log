// =====================================================================
//  طبقة البيانات
//
//  ملاحظة مهمة: لا يوجد في هذا الملف أي فحص صلاحيات.
//  الفحص كله في قاعدة البيانات (سياسات RLS). لو حذف أحدهم كل الشروط
//  من هنا، ستظل Postgres ترجع صفوفه هو فقط. ما تراه هنا استعلامات
//  عادية — والحارس في مكان آخر.
// =====================================================================

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, USER_EMAIL_DOMAIN } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "qml-auth" },
});

// الموظف يدخل باسم مستخدم فنركّب له البريد الداخلي؛ ومن يملك بريداً
// حقيقياً (الأدمن عادةً) يكتبه كما هو فيُستعمل حرفياً — وتبقى له
// استعادة كلمة السر بالبريد.
const emailOf = (id) => {
  const s = String(id).trim().toLowerCase();
  return s.includes("@") ? s : `${s}@${USER_EMAIL_DOMAIN}`;
};

// ---------------------------------------------------------------------
//  الدخول
// ---------------------------------------------------------------------
export async function signIn(username, password) {
  const { data, error } = await sb.auth.signInWithPassword({
    email: emailOf(username),
    password,
  });
  if (error) throw error;
  return data;
}

export const signOut = () => sb.auth.signOut();

/** الملف الشخصي للمستخدم الحالي، أو null إذا لا توجد جلسة. */
export async function fetchMe() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function changeMyPassword(password) {
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw error;
}

// ---------------------------------------------------------------------
//  المواد
//  RLS تتكفّل بالتصفية: الموظف يستقبل مواده فقط مهما طلب.
// ---------------------------------------------------------------------
const toEntry = (r) => ({
  id: r.id,
  owner_id: r.owner_id,
  owner_username: r.owner_username,
  name: r.owner_name,
  directorate: r.directorate,
  title: r.title,
  date: r.entry_date,
  link: r.link,
  notes: r.notes,
  extra: r.extra,
  created_at: r.created_at,
});

export async function listEntries() {
  const { data, error } = await sb
    .from("entries")
    .select("*")
    .order("entry_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(toEntry);
}

export async function createEntry(e, owner) {
  const { data, error } = await sb.from("entries").insert({
    owner_id: owner.id,
    owner_username: owner.username,
    owner_name: owner.full_name,
    directorate: owner.directorate,
    title: e.title,
    entry_date: e.date,
    link: e.link,
    notes: e.notes,
    extra: e.extra,
  }).select().single();
  if (error) throw error;
  return toEntry(data);
}

export async function updateEntry(id, e) {
  const { data, error } = await sb.from("entries").update({
    title: e.title,
    entry_date: e.date,
    link: e.link,
    notes: e.notes,
    extra: e.extra,
  }).eq("id", id).select().single();
  if (error) throw error;
  return toEntry(data);
}

export async function deleteEntry(id) {
  const { error } = await sb.from("entries").delete().eq("id", id);
  if (error) throw error;
}

/** فحص تكرار الرابط عبر كل الفريق — يرجّع {found, owner_name, entry_date, is_mine} أو null. */
export async function checkLink(link) {
  const { data, error } = await sb.rpc("link_check", { p_link: link });
  if (error) throw error;
  return (data && data[0] && data[0].found) ? data[0] : null;
}

// ---------------------------------------------------------------------
//  آخر تقرير
// ---------------------------------------------------------------------
export async function getLastReport(userId, scope) {
  const { data, error } = await sb
    .from("last_reports").select("*")
    .eq("user_id", userId).eq("scope", scope).maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveLastReport(userId, scope, from, to, count) {
  const { error } = await sb.from("last_reports").upsert({
    user_id: userId, scope,
    from_date: from || null, to_date: to,
    item_count: count, exported_at: new Date().toISOString(),
  }, { onConflict: "user_id,scope" });
  if (error) throw error;
}

// ---------------------------------------------------------------------
//  الحسابات — للأدمن. غير الأدمن يستقبل صفّه هو فقط، بحكم RLS.
// ---------------------------------------------------------------------
export async function listProfiles() {
  const { data, error } = await sb.from("profiles").select("*").order("created_at");
  if (error) throw error;
  return data || [];
}

/** تعديل الاسم والصلاحيات والتفعيل — مسموح للأدمن عبر RLS. */
export async function updateProfile(id, patch) {
  const { error } = await sb.from("profiles").update(patch).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------
//  عمليات تحتاج مفتاح الخدمة → تمرّ عبر Edge Function
// ---------------------------------------------------------------------
const FN_ERRORS = {
  not_admin: "هذه العملية للأدمن فقط.",
  bad_username: "اسم المستخدم: حروف إنكليزية صغيرة وأرقام و . _ - فقط، من ٣ إلى ٣٢ خانة.",
  weak_password: "كلمة السر لازم ٨ خانات على الأقل.",
  bad_name: "الاسم قصير أو طويل زيادة.",
  username_taken: "اسم المستخدم محجوز.",
  cannot_delete_self: "ما بتقدر تحذف حسابك أنت.",
  last_admin: "ما بينفع تحذف آخر حساب أدمن.",
  invalid_token: "انتهت الجلسة — سجّل دخول من جديد.",
  missing_token: "انتهت الجلسة — سجّل دخول من جديد.",
  missing_service_key: "الدالة ناقصها مفتاح الخدمة — أضف SB_SECRET_KEY في Edge Functions → Secrets.",
  not_facebook: "هذا مو رابط فيسبوك.",
  nothing_found: "ما قدرت أقرأ شي من هالرابط — تأكد إنه منشور عام.",
  not_allowed: "حسابك معطَّل.",
  server_error: "الدالة وقعت — شوف Logs في Supabase.",
};

async function callFn(name, payload) {
  const { data, error } = await sb.functions.invoke(name, { body: payload });
  if (error) {
    // نقرأ جسم الرد لنعرض سبباً حقيقياً بدل «ما زبطت»
    let code = "", detail = "", status = error.context?.status ?? "";
    try {
      const b = await error.context?.json();
      code = b?.error || "";
      detail = b?.detail || b?.message || b?.msg || "";
    } catch { /* الرد ليس JSON */ }

    if (FN_ERRORS[code]) throw new Error(FN_ERRORS[code]);

    // 401 من منصّة Supabase نفسها، قبل أن يصل الطلب إلى الدالة
    if (String(status) === "401" && !code) {
      throw new Error('الدالة رفضت الجلسة. أطفئ "Verify JWT with legacy secret" من '
        + `Edge Functions ← ${name} ← Settings ← Save changes.`);
    }
    throw new Error(detail ? `${detail} (${status})` : `ما زبطت العملية (${status || "بلا رد"}).`);
  }
  if (data?.error) throw new Error(FN_ERRORS[data.error] || data.error);
  return data;
}

const callAdminFn = (payload) => callFn("admin-users", payload);

/** بيانات مادة من رابط فيسبوك: العنوان دائماً، والتاريخ والمدة إن ضُبط توكن الصفحة. */
export const lookupFacebook = (url) => callFn("fb-lookup", { url });

export const createAccount  = (p) => callAdminFn({ action: "create", ...p });
export const resetPassword  = (id, password) => callAdminFn({ action: "reset_password", id, password });
export const deleteAccount  = (id) => callAdminFn({ action: "delete", id });
