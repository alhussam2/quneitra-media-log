// =====================================================================
//  admin-users — إنشاء حسابات الموظفين وتغيير كلمات السر وحذف الحسابات
//
//  تعمل على سيرفر Supabase لأنها تحتاج مفتاح الخدمة (service role).
//  هذا المفتاح لا ينزل إلى المتصفح أبداً — ولو نزل لسقطت كل الحماية.
//
//  كل طلب يمرّ ببوابتين قبل أي شيء:
//    1. توكن دخول صالح
//    2. صاحب التوكن دوره admin وحسابه مفعّل
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

// نطاق البريد الداخلي: الموظف يدخل باسم مستخدم، ونحن نحوّله إلى بريد
// لأن Supabase Auth يعمل بالبريد. لا تُرسَل أي رسالة إلى هذا النطاق.
// لازم يطابق USER_EMAIL_DOMAIN في src/config.js حرفياً.
const EMAIL_DOMAIN = "users.quneitra-media.app";

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD = 8;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // ---- البوابة 1: توكن صالح ----
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "missing_token" }, 401);

  const { data: caller, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !caller?.user) return json({ error: "invalid_token" }, 401);

  // ---- البوابة 2: أدمن مفعّل ----
  const { data: me } = await admin
    .from("profiles").select("role, active").eq("id", caller.user.id).maybeSingle();
  if (!me || me.role !== "admin" || !me.active) return json({ error: "not_admin" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body.action ?? "");

  // =================================================================
  //  إنشاء حساب
  // =================================================================
  if (action === "create") {
    const username = String(body.username ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const fullName = String(body.full_name ?? "").trim();

    if (!USERNAME_RE.test(username)) return json({ error: "bad_username" }, 400);
    if (password.length < MIN_PASSWORD) return json({ error: "weak_password" }, 400);
    if (fullName.length < 2 || fullName.length > 80) return json({ error: "bad_name" }, 400);

    const { data: taken } = await admin
      .from("profiles").select("id").eq("username", username).maybeSingle();
    if (taken) return json({ error: "username_taken" }, 409);

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: `${username}@${EMAIL_DOMAIN}`,
      password,
      email_confirm: true,
      user_metadata: { username, full_name: fullName },
    });
    if (createErr || !created?.user) {
      return json({ error: "create_failed", detail: createErr?.message }, 400);
    }

    const profile: Record<string, unknown> = {
      id: created.user.id,
      username,
      full_name: fullName,
      role: body.role === "admin" ? "admin" : "member",
      can_add: body.can_add !== false,
      can_edit_own: body.can_edit_own !== false,
      can_export: body.can_export !== false,
    };
    if (body.directorate) profile.directorate = String(body.directorate);
    if (body.section) profile.section = String(body.section);

    const { error: profErr } = await admin.from("profiles").insert(profile);
    if (profErr) {
      // لا نترك حساب دخول بلا ملف — نتراجع عن الخطوة الأولى
      await admin.auth.admin.deleteUser(created.user.id);
      return json({ error: "profile_failed", detail: profErr.message }, 400);
    }
    return json({ ok: true, id: created.user.id, username });
  }

  // =================================================================
  //  تغيير كلمة السر
  // =================================================================
  if (action === "reset_password") {
    const id = String(body.id ?? "");
    const password = String(body.password ?? "");
    if (!id) return json({ error: "missing_id" }, 400);
    if (password.length < MIN_PASSWORD) return json({ error: "weak_password" }, 400);

    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) return json({ error: "reset_failed", detail: error.message }, 400);
    return json({ ok: true });
  }

  // =================================================================
  //  حذف حساب — المواد تبقى، owner_id يصير NULL والاسم محفوظ
  // =================================================================
  if (action === "delete") {
    const id = String(body.id ?? "");
    if (!id) return json({ error: "missing_id" }, 400);
    if (id === caller.user.id) return json({ error: "cannot_delete_self" }, 400);

    const { data: target } = await admin
      .from("profiles").select("role").eq("id", id).maybeSingle();
    if (target?.role === "admin") {
      const { count } = await admin
        .from("profiles").select("id", { count: "exact", head: true })
        .eq("role", "admin").eq("active", true);
      if ((count ?? 0) <= 1) return json({ error: "last_admin" }, 400);
    }

    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) return json({ error: "delete_failed", detail: error.message }, 400);
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
});
