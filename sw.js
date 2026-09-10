// =====================================================================
//  عامل الخدمة — يجعل التطبيق يفتح فوراً وبلا اتصال قوي
//
//  يخبّئ قشرة التطبيق (HTML/CSS/JS/الأيقونات) فقط. لا يلمس نداءات
//  Supabase أبداً: تلك ديناميكية ومصادَق عليها، فتمرّ إلى الشبكة كما هي.
//  بلا هذا الاستثناء قد يخدم التطبيق بياناتٍ قديمة — وهو ما لا نقبله هنا.
//
//  رقم النسخة يُبطل الخبيئة القديمة عند كل نشر. غيّره حين تغيّر أصول القشرة.
// =====================================================================

const VERSION = "qml-v2";
const SHELL = [
  "./",
  "./index.html",
  "./assets/styles.css",
  "./src/app.js",
  "./src/api.js",
  "./src/dates.js",
  "./src/xlsx.js",
  "./src/config.js",
  "./vendor/template.b64.js",
  "./assets/logo-full.png",
  "./assets/logo-mark.png",
  "./assets/favicon.png",
  "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  // نخبّئ ما نقدر؛ فشل أصل واحد يجب ألا يُسقط التنصيب كله
  e.waitUntil(
    caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // كل ما ليس أصلاً ثابتاً من موقعنا يمرّ مباشرة إلى الشبكة:
  //   - نداءات Supabase (أصل آخر) → دائماً حيّة
  //   - غير GET (رفع، حذف)         → لا تُخبّأ
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // مستندات التنقّل: الشبكة أولاً ليصل أحدث إصدار، والخبيئة شبكة أمان
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put("./index.html", copy));
        return res;
      }).catch(() => caches.match("./index.html")),
    );
    return;
  }

  // بقية أصول القشرة: خبيئة أولاً للسرعة، مع تحديثها في الخلفية
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    }),
  );
});
