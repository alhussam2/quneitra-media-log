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

// مكتبة supabase-js ترسل apikey و x-client-info مع كل نداء دالة.
// أي ترويسة غير مذكورة هنا يرفضها المتصفح في طلب الفحص المسبق،
// فيُلغى الطلب قبل مغادرته الجهاز ولا يصل أي رد ليُقرأ سببه.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
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

/** يحوّل قيمة زمنية (ISO أو epoch ثوانٍ/مِلّي) إلى YYYY-MM-DD ضمن نطاق معقول. */
function toDate(v: unknown): string | null {
  if (v == null) return null;
  let ms: number | null = null;
  if (typeof v === "number") ms = v < 1e12 ? v * 1000 : v;          // ثوانٍ أو ملّي
  else if (/^\d{9,13}$/.test(String(v))) { const n = +v; ms = n < 1e12 ? n * 1000 : n; }
  else { const t = Date.parse(String(v)); if (!Number.isNaN(t)) ms = t; }
  if (ms == null) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (y < 2010 || y > 2035) return null;                            // نتجاهل قيَماً غير منطقية
  return d.toISOString().slice(0, 10);
}

/** يبحث في كائن Apify عن أوّل حقل تاريخ نشر معقول (بلا اعتماد على اسم واحد). */
function findDateDeep(obj: unknown, depth = 0): string | null {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  const rec = obj as Record<string, unknown>;
  // نفضّل تاريخ النشر الصريح أولاً (date_posted لـBright Data، time لـApify)
  const preferred = ["date_posted", "datePosted", "post_date", "posted_at", "published_at",
                     "publishedTime", "publish_time", "publishTime", "created_time", "creation_time",
                     "publishedAt", "createdTime", "time", "timestamp", "date"];
  for (const k of preferred) {
    if (k in rec) { const d = toDate(rec[k]); if (d) return d; }
  }
  // بحث عام، مع تجاهل حقول وقت الكشط/الجلب لا النشر
  for (const [k, v] of Object.entries(rec)) {
    if (/scrap|crawl|collect|fetch|snapshot|retriev|updated|modified|access|warc/i.test(k)) continue;
    if (/time|date|publish|created|posted/i.test(k)) { const d = toDate(v); if (d) return d; }
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object") { const d = findDateDeep(v, depth + 1); if (d) return d; }
  }
  return null;
}

/** يبحث عن مدة الفيديو بالثواني إن وُجدت. */
function findDurationDeep(obj: unknown, depth = 0): number | null {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  const rec = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    if (/duration|length/i.test(k)) {
      const n = typeof v === "number" ? v : (/^\d+(\.\d+)?$/.test(String(v)) ? +v : NaN);
      if (Number.isFinite(n) && n > 0 && n < 86400) return n > 1000 ? n / 1000 : n; // ملّي→ثانية
    }
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object") { const d = findDurationDeep(v, depth + 1); if (d) return d; }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BD_DATASET = "gd_lkaxegm826bjpoo9m5";  // Facebook Posts dataset

/** يجلب أول سجل منشور من Bright Data لرابط واحد (يعيد null عند الفشل/المهلة). */
async function brightData(url: string, token: string): Promise<Record<string, unknown> | null> {
  const auth = { Authorization: `Bearer ${token}` };
  // 1) إطلاق المهمة
  const trig = await fetch(
    `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${BD_DATASET}&format=json&include_errors=true`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify([{ url, num_of_posts: 1 }]),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const tj = await trig.json();
  const snap = tj?.snapshot_id;
  if (!snap) throw new Error(tj?.error ? String(tj.error) : "bd_no_snapshot");

  // 2) انتظار الجاهزية (حتى ~90 ثانية)
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const pr = await fetch(`https://api.brightdata.com/datasets/v3/progress/${snap}`,
      { headers: auth, signal: AbortSignal.timeout(15_000) });
    const pj = await pr.json();
    if (pj?.status === "ready") { ready = true; break; }
    if (pj?.status === "failed") throw new Error("bd_failed");
  }
  if (!ready) throw new Error("bd_timeout");

  // 3) جلب النتيجة
  const sr = await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${snap}?format=json`,
    { headers: auth, signal: AbortSignal.timeout(20_000) });
  const items = await sr.json();
  return Array.isArray(items) && items[0] ? items[0] : null;
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

    let body: { url?: string; usage?: boolean };
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

    // ---- الاستخدام الحقيقي من Apify (للأدمن فقط) ----
    if (body.usage === true) {
      const { data: prof } = await admin
        .from("profiles").select("role").eq("id", caller.user.id).maybeSingle();
      if (prof?.role !== "admin") return json({ error: "not_admin" }, 403);
      const tok = Deno.env.get("APIFY_TOKEN");
      if (!tok) return json({ ok: true, usageUsd: null, noToken: true });
      try {
        const r = await fetch(
          `https://api.apify.com/v2/users/me/usage/monthly?token=${encodeURIComponent(tok)}`,
          { signal: AbortSignal.timeout(15_000) },
        );
        const j = await r.json();
        const d = j?.data ?? {};
        const used = Number(d.totalUsageCreditsUsdAfterVolumeDiscount
          ?? d.totalUsageCreditsUsdBeforeVolumeDiscount ?? 0);
        return json({ ok: true, usageUsd: used });
      } catch (e) {
        return json({ ok: true, usageUsd: null, apifyError: e instanceof Error ? e.message : String(e) });
      }
    }

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

    // ---- (ب٢) Apify ثم Bright Data: تحويل حسب رصيد Apify المستهلك ----
    const apifyToken = Deno.env.get("APIFY_TOKEN");
    const bdToken = Deno.env.get("BRIGHTDATA_TOKEN");
    const month = new Date().toISOString().slice(0, 7);
    const APIFY_CAP = 4.8;                        // نترك هامشاً قبل حدّ الـ$5
    let apifyError: string | null = null;
    let apifyTried = false;
    let bdError: string | null = null;
    let bdTried = false;
    let usedSource: string | null = null;

    // كم استهلك Apify هذا الشهر؟ (المخزَّن يكفي للقرار؛ يعود لصفر مع الشهر الجديد)
    let apifyUsd = 0;
    try {
      const { data: uRow } = await admin.from("apify_usage").select("usd").eq("month", month).maybeSingle();
      apifyUsd = Number(uRow?.usd ?? 0);
    } catch { /* لو تعذّر، نعتبره 0 */ }
    const apifyAvailable = Boolean(apifyToken) && apifyUsd < APIFY_CAP;

    if (!date && apifyAvailable) {
      apifyTried = true;
      try {
        const runUrl = `https://api.apify.com/v2/acts/apify~facebook-posts-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(apifyToken)}`;
        const res = await fetch(runUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startUrls: [{ url: target }], resultsLimit: 1 }),
          signal: AbortSignal.timeout(110_000),   // تشغيل المتصفح قد يأخذ لحظات
        });
        if (!res.ok) {
          apifyError = `apify ${res.status}`;
        } else {
          const items = await res.json();
          const item = Array.isArray(items) ? items[0] : null;
          if (item) {
            const d = findDateDeep(item);
            if (d) { date = d; usedSource = "apify"; }
            // سجّل النداء، ثم خزّن التكلفة الحقيقية من Apify (كلاهما ثانوي)
            try {
              await admin.rpc("bump_apify", { p_month: month });
              try {
                const ur = await fetch(
                  `https://api.apify.com/v2/users/me/usage/monthly?token=${encodeURIComponent(apifyToken)}`,
                  { signal: AbortSignal.timeout(10_000) },
                );
                const uj = await ur.json();
                const ud = uj?.data ?? {};
                const usd = Number(ud.totalUsageCreditsUsdAfterVolumeDiscount
                  ?? ud.totalUsageCreditsUsdBeforeVolumeDiscount ?? NaN);
                if (Number.isFinite(usd)) {
                  await admin.from("apify_usage").update({ usd }).eq("month", month);
                }
              } catch { /* التكلفة تُحدَّث لاحقاً */ }
            } catch { /* العدّاد ثانوي */ }
            if (!duration) {
              const sec = findDurationDeep(item);
              if (sec) duration = fmtDuration(sec);
            }
            if (!graphTitle && !pageTitle) {
              const t = (item.text || item.title || item.caption || "");
              if (t) pageTitle = String(t).split("\n")[0].slice(0, 200);
            }
          } else {
            apifyError = "apify_empty";
          }
        }
      } catch (e) {
        apifyError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
    }

    // ---- Bright Data: يُستعمل حين خلص رصيد Apify أو فشل ----
    if (!date && bdToken) {
      bdTried = true;
      try {
        const bdUrl = canonical || target;      // الرابط القانوني أفضل للكشط
        const item = await brightData(bdUrl, bdToken);
        // التقط أسماء الحقول وقيَم التواريخ لأقرأها وأصلّح بدقة (تشخيص مؤقت)
        try {
          if (item) {
            const dbg: Record<string, unknown> = { keys: Object.keys(item) };
            for (const [k, v] of Object.entries(item)) {
              if (/date|time|post|publish|length|duration/i.test(k)) dbg[k] = v;
            }
            await admin.from("apify_usage").update({ debug: JSON.stringify(dbg).slice(0, 3000) }).eq("month", month);
          } else {
            await admin.from("apify_usage").update({ debug: "bd item null for " + bdUrl }).eq("month", month);
          }
        } catch { /* تشخيص ثانوي */ }
        if (item) {
          const d = findDateDeep(item);
          if (d) {
            date = d;
            usedSource = "brightdata";
            try { await admin.rpc("bump_bd", { p_month: month }); } catch { /* عدّاد ثانوي */ }
          }
          if (!duration) { const sec = findDurationDeep(item); if (sec) duration = fmtDuration(sec); }
          if (!graphTitle && !pageTitle) {
            const t = (item.text || item.title || item.caption || item.content || "");
            if (t) pageTitle = String(t).split("\n")[0].slice(0, 200);
          }
        } else { bdError = "bd_empty"; }
      } catch (e) {
        bdError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
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
      source: graphTitle ? "graph" : (usedSource ?? "page"),
      hasToken: Boolean(token),
      hasApify: Boolean(apifyToken),
      hasBrightData: Boolean(bdToken),
      apifyTried,
      apifyError,
      bdTried,
      bdError,
      graphError,                 // يظهر في الواجهة حين يكون التوكن منتهياً
      fetchError,                 // سبب تعذّر قراءة الصفحة، إن حصل
    });
  } catch (e) {
    // بلا هذا الغلاف يموت الطلب دون ترويسات CORS، فيرى المتصفح «بلا رد»
    return json({ error: "server_error", detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, 500);
  }
});
