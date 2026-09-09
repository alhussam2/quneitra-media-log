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

const emailOf = (username) => `${String(username).trim().toLowerCase()}@${USER_EMAIL_DOMAIN}`;

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
};

async function callAdminFn(payload) {
  const { data, error } = await sb.functions.invoke("admin-users", { body: payload });
  if (error) {
    // نحاول قراءة رمز الخطأ من جسم الرد لعرض رسالة مفهومة
    let code = "";
    try { code = (await error.context?.json())?.error || ""; } catch { /* لا شيء */ }
    throw new Error(FN_ERRORS[code] || "ما زبطت العملية — جرّب مرة تانية.");
  }
  if (data?.error) throw new Error(FN_ERRORS[data.error] || data.error);
  return data;
}

export const createAccount  = (p) => callAdminFn({ action: "create", ...p });
export const resetPassword  = (id, password) => callAdminFn({ action: "reset_password", id, password });
export const deleteAccount  = (id) => callAdminFn({ action: "delete", id });
