-- =====================================================================
--  حساب الأدمن الأول
--
--  مشكلة البيضة والدجاجة: إنشاء الحسابات من التطبيق يحتاج أدمن،
--  وما في أدمن بعد. فالأول يُنشأ من هنا مرة واحدة.
--
--  خطوتان بالترتيب:
--    1. Authentication → Users → Add user  (فعّل Auto Confirm User)
--    2. شغّل هذا الملف بعد تبديل البريد والاسم
--
--  ملاحظة: هذا أمر مباشر لا دالة. محرّر SQL في Supabase ينفّذ السكربت
--  كصفقة واحدة، فأي خطأ في المنتصف يسحب معه إنشاء الدوال — وهو ما
--  يجعل صيغة الدالة تختفي بصمت بعد أول فشل.
-- =====================================================================

insert into public.profiles
  (id, username, full_name, role, can_add, can_edit_own, can_export, active)
select
  u.id,
  'admin',                          -- ← اسم المستخدم
  'اسمك الكامل',                    -- ← الاسم في عمود «الأسم» بملف Excel
  'admin', true, true, true, true
from auth.users u
where lower(u.email) = lower('بريدك@هنا')   -- ← بريد الدخول
on conflict (id) do update set
  role      = 'admin',
  active    = true,
  username  = excluded.username,
  full_name = excluded.full_name;

-- تحقّق: لازم يظهر صف واحد دوره admin ومفعّل
select username, full_name, role, active from public.profiles;
