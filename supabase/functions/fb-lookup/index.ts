// =====================================================================
//  fb-lookup — قراءة بيانات مادة من رابط فيديو فيسبوك
//
//  لماذا على السيرفر: المتصفح ممنوع من طلب facebook.com (CORS)، والسيرفر
//  ليس ممنوعاً. ولأن التوكن — إن وُجد — يجب ألا ينزل إلى العميل.
//
//  مساران:
//    أ. Graph API  — إن ضُبط FB_PAGE_TOKEN. يعطي العنوان والتاريخ والمدة.
//       هذا هو الطريق الرسمي، ويعمل لفيديوهات الصفحات التي تديرها.
//    ب. قراءة الصفحة — بلا توكن. تعطي العنوان فقط. تعتمد على أن فيسبوك
//       يخدم بطاقات المشاركة، وقد يتوقف في أي وقت دون إنذار.
//
//  المسار (ب) احتياطي مؤقت لا أساس: أضف التوكن متى استطعت.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

const CRAWLER_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const GRAPH = "https://graph.facebook.com/v21.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

/** ثوانٍ → 13:42 */
function fmtDuration(seconds: number): string {
  const t = Math.round(seconds);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function meta(htmlText: string, prop: string): string | null {
  const re = new RegExp(`property="og:${prop}"\\s+content="([^"]*)"`);
  const m = htmlText.match(re);
  if (!m) return null;
  return m[1]
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .trim();
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SB_SECRET_KEY");
    if (!SERVICE_KEY) return json({ error: "missing_service_key" }, 500);

    // لا تُقرأ روابط لغير مستخدم مسجَّل ومفعَّل
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "missing_token" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: caller } = await admin.auth.getUser(jwt);
    if (!caller?.user) return json({ error: "invalid_token" }, 401);

    const { data: me } = await admin
      .from("profiles").select("active").eq("id", caller.user.id).maybeSingle();
    if (!me?.active) return json({ error: "not_allowed" }, 403);

    let body: { url?: string };
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

    const target = String(body.url ?? "").trim();
    if (!/^https?:\/\/([a-z0-9-]+\.)*(facebook\.com|fb\.watch|fb\.me)\//i.test(target)) {
      return json({ error: "not_facebook" }, 400);
    }

    // ---- (ب) قراءة الصفحة: العنوان ورقم الفيديو ----
    let pageTitle: string | null = null;
    let videoId: string | null = null;
    let canonical: string | null = null;

    let fetchError: string | null = null;
    try {
      const res = await fetch(target, {
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),   // لا نترك الدالة معلّقة حتى تُقتل
        headers: { "user-agent": CRAWLER_UA, "accept-language": "ar,en;q=0.8" },
      });
      if (!res.ok) fetchError = `فيسبوك ردّ ${res.status}`;
      const text = await res.text();

      // og:description أنظف من og:title — الأخير مسبوق بعدد المشاهدات والتفاعلات
      pageTitle = meta(text, "description");
      if (!pageTitle) {
        const t = meta(text, "title");
        if (t) pageTitle = t.replace(/^[^|]*\|\s*/, "").trim();  // احذف «٢٫٥ ألف مشاهدة · ٤٦ تفاعلاً |»
      }
      videoId = (text.match(/"video_id"\s*:\s*"(\d+)"/) || [])[1] ?? null;
      if (!videoId) videoId = (target.match(/[?&]v=(\d+)/) || target.match(/\/videos\/(?:[^/]*\/)?(\d+)/) || [])[1] ?? null;

      const alt = text.match(/hreflang="x-default" href="([^"]+)"/);
      if (alt) canonical = decodeURIComponent(alt[1]);
    } catch (e) {
      fetchError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }

    // ---- (أ) Graph API: التاريخ والمدة والعنوان الرسمي ----
    const token = Deno.env.get("FB_PAGE_TOKEN");
    let date: string | null = null;
    let duration: string | null = null;
    let graphTitle: string | null = null;
    let graphError: string | null = null;

    if (token && videoId) {
      try {
        const url = `${GRAPH}/${videoId}?fields=title,description,created_time,length&access_token=${encodeURIComponent(token)}`;
        const r = await fetch(url);
        const g = await r.json();
        if (g.error) {
          graphError = String(g.error.message ?? "graph_error");
        } else {
          if (g.created_time) date = String(g.created_time).slice(0, 10);
          if (typeof g.length === "number") duration = fmtDuration(g.length);
          graphTitle = g.title || g.description || null;
        }
      } catch (e) {
        graphError = String(e);
      }
    }

    const title = (graphTitle || pageTitle || "").replace(/\s+/g, " ").trim();
    if (!title && !date && !duration) {
      return json({ error: "nothing_found", detail: fetchError, videoId, canonical }, 404);
    }

    return json({
      ok: true,
      title,
      date,                       // null ما لم يُضبط FB_PAGE_TOKEN
      duration,                   // null ما لم يُضبط FB_PAGE_TOKEN
      videoId,
      canonical,
      source: graphTitle ? "graph" : "page",
      hasToken: Boolean(token),
      graphError,                 // يظهر في الواجهة حين يكون التوكن منتهياً
      fetchError,                 // سبب تعذّر قراءة الصفحة، إن حصل
    });
  } catch (e) {
    // بلا هذا الغلاف يموت الطلب دون ترويسات CORS، فيرى المتصفح «بلا رد»
    return json({ error: "server_error", detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, 500);
  }
});
