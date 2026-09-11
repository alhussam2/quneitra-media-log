-- =====================================================================
--  عدّاد استخدام Apify — صف واحد لكل شهر
--  fb-lookup تزيد العدّاد بعد كل نداء ناجح لـApify. الأدمن يقرأه.
-- =====================================================================

create table if not exists public.apify_usage (
  month  text primary key,          -- "2026-09"
  calls  integer not null default 0,
  updated_at timestamptz not null default now()
);

-- زيادة ذرّية آمنة (تُستدعى من الدالة بمفتاح الخدمة، ومن الأدمن للقراءة)
create or replace function public.bump_apify(p_month text)
returns void language sql security definer set search_path = public as $$
  insert into public.apify_usage (month, calls, updated_at)
  values (p_month, 1, now())
  on conflict (month) do update
    set calls = public.apify_usage.calls + 1, updated_at = now();
$$;

alter table public.apify_usage enable row level security;

-- الأدمن وحده يقرأ العدّاد
drop policy if exists apify_usage_read on public.apify_usage;
create policy apify_usage_read on public.apify_usage for select to authenticated
  using (public.is_admin());

revoke all on function public.bump_apify(text) from public, anon, authenticated;
grant execute on function public.bump_apify(text) to service_role;
grant select on public.apify_usage to authenticated;
