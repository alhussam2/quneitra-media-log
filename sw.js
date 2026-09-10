// =====================================================================
//  عامل الخدمة — يجعل التطبيق يفتح فوراً وبلا اتصال قوي
//
//  يخبّئ قشرة التطبيق (HTML/CSS/JS/الأيقونات) فقط. لا يلمس نداءات
//  Supabase أبداً: تلك ديناميكية ومصادَق عليها، فتمرّ إلى الشبكة كما هي.
//  بلا هذا الاستثناء قد يخدم التطبيق بياناتٍ قديمة — وهو ما لا نقبله هنا.
//
//  رقم النسخة يُبطل الخبيئة القديمة عند كل نشر. غيّره حين تغيّر أصول القشرة.
// =====================================================================

const VERSION = "qml-v3";
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

  // الشبكة أولاً لكل أصول القشرة: يصل أحدث كود فوراً حين يوجد اتصال،
  // والخبيئة شبكة أمان عند انقطاعه فقط. فلا تتأخّر الإصلاحات ولا تُخدَّم
  // نسخة قديمة. مستندات التنقّل ترجع إلى index.html المخبّأ عند الانقطاع.
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())),
    ),
  );
});
