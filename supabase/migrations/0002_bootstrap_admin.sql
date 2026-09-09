-- =====================================================================
--  إنشاء حساب الأدمن الأول
--
--  مشكلة البيضة والدجاجة: إنشاء الحسابات يحتاج أدمن، وما في أدمن بعد.
--  الحل: هذه الدالة تعمل مرة واحدة فقط — ترفض التنفيذ إذا وُجد أدمن
--  مفعّل. ولا تُمنح صلاحية تشغيلها لأي مستخدم، فلا تُستدعى إلا من
--  SQL Editor في لوحة Supabase (يعمل بصلاحية postgres).
-- =====================================================================

create or replace function public.bootstrap_admin(
  p_email     text,   -- بريد المستخدم الذي أنشأته من Authentication → Add user
  p_username  text,   -- اسم المستخدم للدخول، حروف لاتينية صغيرة
  p_full_name text    -- الاسم كما يُكتب في عمود «الأسم» بملف Excel
) returns text
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if exists (select 1 from public.profiles where role = 'admin' and active) then
    raise exception 'يوجد حساب أدمن مفعّل — أنشئ باقي الحسابات من داخل التطبيق';
  end if;

  select id into v_id from auth.users where lower(email) = lower(btrim(p_email));
  if v_id is null then
    raise exception 'ما في مستخدم بهذا البريد: %  — أنشئه أولاً من Authentication → Users → Add user', p_email;
  end if;

  insert into public.profiles (id, username, full_name, role,
                               can_add, can_edit_own, can_export, active)
  values (v_id, lower(btrim(p_username)), btrim(p_full_name), 'admin',
          true, true, true, true)
  on conflict (id) do update
    set role = 'admin', active = true,
        username = excluded.username, full_name = excluded.full_name;

  return 'تم: حساب الأدمن ' || p_username || ' جاهز';
end;
$$;

revoke all on function public.bootstrap_admin(text, text, text) from public, anon, authenticated;

-- --------------------------------------------------------------------
--  الاستعمال (بدّل القيم ثم شغّل السطر):
--
--    select public.bootstrap_admin(
--      'admin@users.quneitra-media.app',   -- نفس البريد الذي أنشأته
--      'admin',                            -- اسم المستخدم للدخول
--      'اسمك الكامل'
--    );
-- --------------------------------------------------------------------
