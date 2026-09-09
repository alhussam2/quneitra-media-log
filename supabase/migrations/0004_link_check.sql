-- =====================================================================
--  فحص تكرار الرابط عبر كل الفريق
--
--  المشكلة: RLS تمنع الموظف من رؤية مواد غيره، فما يقدر يكشف تكراراً
--  سجّله زميل. الحل: دالة SECURITY DEFINER تفحص كل المواد لكنها ترجّع
--  الحدّ الأدنى فقط (موجود؟ باسم مين؟ بأي تاريخ؟) — بلا عنوان ولا رابط
--  ولا ملاحظات. فلا تسريب، والرسالة مفيدة.
-- =====================================================================

-- مفتاح مطابقة ثابت: رقم الفيديو (١٠ خانات فأكثر) إن وُجد، وإلا رمز
-- المشاركة، وإلا المسار نظيفاً من البروتوكول وwww والمعامِلات والشرطة.
create or replace function public.norm_link(u text)
returns text language sql immutable as $$
  select case
    when u is null or btrim(u) = '' then ''
    else coalesce(
      (regexp_match(u, '(\d{10,})'))[1],
      (regexp_match(u, '/share/[a-z]/([A-Za-z0-9]+)'))[1],
      lower(regexp_replace(
        regexp_replace(split_part(u, '?', 1), '^https?://(www\.)?', ''),
        '/+$', ''))
    )
  end
$$;

create or replace function public.link_check(p_link text)
returns table(found boolean, owner_name text, entry_date date, is_mine boolean)
language plpgsql stable security definer set search_path = public as $$
declare k text;
begin
  k := public.norm_link(p_link);
  if k = '' then
    return query select false, null::text, null::date, false;
    return;
  end if;
  return query
    select true, e.owner_name, e.entry_date, (e.owner_id = auth.uid())
    from public.entries e
    where public.norm_link(e.link) = k
    order by e.created_at
    limit 1;
end;
$$;

revoke all on function public.link_check(text) from public, anon;
grant execute on function public.link_check(text) to authenticated;
