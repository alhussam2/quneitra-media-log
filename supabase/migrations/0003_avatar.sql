-- =====================================================================
--  صورة الملف الشخصي
--
--  تُخزَّن كـdata URI داخل صف الحساب لا في مخزن ملفات: التطبيق يصغّرها
--  إلى 128×128 قبل الرفع فتبقى بضعة كيلوبايتات، ويوفّر ذلك إنشاء
--  bucket وسياسات تخزين منفصلة. الحدّ أدناه يمنع صفّاً منتفخاً.
--
--  الصلاحية: سياسة profiles_update تسمح لكل شخص بتعديل صفّه، وتريغر
--  guard_profile_update يمنعه من مسّ الدور والصلاحيات. فالصورة يغيّرها
--  صاحبها وحده (أو الأدمن)، ولا شيء غيرها ينفتح بذلك.
-- =====================================================================

alter table public.profiles
  add column if not exists avatar text;

alter table public.profiles
  drop constraint if exists avatar_small;

alter table public.profiles
  add constraint avatar_small
  check (avatar is null or length(avatar) <= 120000);
