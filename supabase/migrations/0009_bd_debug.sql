-- تشخيص مؤقت: مخرجات Bright Data الفعلية لأقرأ أسماء الحقول وأصلّح بدقة
alter table public.apify_usage add column if not exists debug text;

create or replace function public.apify_month_stats(p_month text default to_char(now(),'YYYY-MM'))
returns json language sql security definer set search_path = public as $$
  select coalesce(
    (select json_build_object('calls', calls, 'bd_calls', bd_calls, 'usd', usd,
                              'debug', debug, 'updated_at', updated_at)
       from public.apify_usage where month = p_month),
    json_build_object('calls', 0, 'bd_calls', 0, 'usd', null, 'debug', null, 'updated_at', null));
$$;
grant execute on function public.apify_month_stats(text) to anon, authenticated;
