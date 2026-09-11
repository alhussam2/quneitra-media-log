-- =====================================================================
--  تخزين تكلفة Apify الحقيقية (بالدولار) لكل شهر + قراءة عامة للرقم فقط
--  fb-lookup تحدّثها بعد كل جلب ناجح؛ الرقم غير حسّاس فيُقرأ بلا دخول.
-- =====================================================================

alter table public.apify_usage add column if not exists usd numeric;

create or replace function public.apify_month_stats(p_month text default to_char(now(),'YYYY-MM'))
returns json language sql security definer set search_path = public as $$
  select coalesce(
    (select json_build_object('calls', calls, 'usd', usd, 'updated_at', updated_at)
       from public.apify_usage where month = p_month),
    json_build_object('calls', 0, 'usd', null, 'updated_at', null));
$$;

grant execute on function public.apify_month_stats(text) to anon, authenticated;
