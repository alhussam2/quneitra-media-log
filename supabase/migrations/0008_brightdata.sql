-- =====================================================================
--  عدّاد Bright Data (البديل) — عمود ودالة زيادة، وتوسيع دالة القراءة
-- =====================================================================

alter table public.apify_usage add column if not exists bd_calls integer not null default 0;

create or replace function public.bump_bd(p_month text)
returns void language sql security definer set search_path = public as $$
  insert into public.apify_usage (month, calls, bd_calls, updated_at)
  values (p_month, 0, 1, now())
  on conflict (month) do update
    set bd_calls = public.apify_usage.bd_calls + 1, updated_at = now();
$$;

revoke all on function public.bump_bd(text) from public, anon, authenticated;
grant execute on function public.bump_bd(text) to service_role;

-- توسيع القراءة العامة لتشمل عدّاد Bright Data
create or replace function public.apify_month_stats(p_month text default to_char(now(),'YYYY-MM'))
returns json language sql security definer set search_path = public as $$
  select coalesce(
    (select json_build_object('calls', calls, 'bd_calls', bd_calls, 'usd', usd, 'updated_at', updated_at)
       from public.apify_usage where month = p_month),
    json_build_object('calls', 0, 'bd_calls', 0, 'usd', null, 'updated_at', null));
$$;
grant execute on function public.apify_month_stats(text) to anon, authenticated;
