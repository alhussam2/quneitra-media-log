-- =====================================================================
--  سجل مواد القنيطرة — المخطط الأساسي
--  Quneitra media log — schema, roles and row level security
--
--  شغّل هذا الملف مرة واحدة في Supabase → SQL Editor.
--  كل الحماية هنا: التطبيق لا يقرر من يرى ماذا، Postgres هو الذي يقرر.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. الحسابات
--    صف واحد لكل موظف، مربوط بحساب الدخول في auth.users.
--    كلمات السر لا تُخزَّن هنا إطلاقاً — Supabase Auth يتولاها (bcrypt).
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique
               check (username ~ '^[a-z0-9._-]{3,32}$'),
  full_name    text not null check (length(btrim(full_name)) between 2 and 80),
  role         text not null default 'member' check (role in ('admin','member')),
  directorate  text not null default 'مديرية إعلام القنيطرة',
  section      text not null default 'دائرة الإنتاج',

  -- الصلاحيات التي يحدّدها الأدمن لكل حساب
  can_add      boolean not null default true,   -- يضيف مواد
  can_edit_own boolean not null default true,   -- يعدّل ويحذف مواده
  can_export   boolean not null default true,   -- يصدّر تقرير بمواده

  active       boolean not null default true,   -- التعطيل يمنع الدخول
  created_at   timestamptz not null default now()
);

comment on table public.profiles is 'حساب موظف: الاسم والصلاحيات. كلمة السر في auth.users لا هنا.';

-- ---------------------------------------------------------------------
-- 2. المواد
--    owner_id يصير NULL لو حُذف الحساب، لكن owner_name و owner_username
--    يبقيان — فالإنجاز يظل موثّقاً باسم صاحبه ويظهر للأدمن بعد الحذف.
-- ---------------------------------------------------------------------
create table if not exists public.entries (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid references public.profiles(id) on delete set null,
  owner_username text not null,
  owner_name     text not null,          -- يذهب إلى عمود «الأسم» في ملف Excel
  directorate    text not null default 'مديرية إعلام القنيطرة',

  title          text not null default '' check (length(title) <= 300),
  entry_date     date not null,
  link           text not null default '' check (length(link) <= 2000),
  notes          text not null default '' check (length(notes) <= 2000),
  extra          text not null default '' check (length(extra) <= 120),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint entry_not_empty check (length(btrim(title)) > 0 or length(btrim(link)) > 0)
);

create index if not exists entries_owner_date_idx on public.entries (owner_id, entry_date desc);
create index if not exists entries_date_idx       on public.entries (entry_date desc);
create index if not exists entries_username_idx   on public.entries (owner_username);

-- ---------------------------------------------------------------------
-- 3. آخر تقرير — التذكير الذي يقول «من وين تكمّل»
--    scope: 'own' لتقرير الموظف عن نفسه، أو اسم المستخدم الذي صدّره
--    الأدمن، أو '_all' لتقرير الجميع.
-- ---------------------------------------------------------------------
create table if not exists public.last_reports (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  scope       text not null default 'own',
  from_date   date,
  to_date     date not null,
  item_count  integer not null default 0,
  exported_at timestamptz not null default now(),
  primary key (user_id, scope)
);

-- ---------------------------------------------------------------------
-- 4. دوال الصلاحية
--    SECURITY DEFINER = تعمل بصلاحيات مالك الدالة، فلا تُفعِّل سياسات
--    profiles من جديد ولا تقع في استدعاء لا نهائي.
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin' and p.active
  );
$$;

create or replace function public.can_add()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and (p.can_add or p.role = 'admin')
  );
$$;

create or replace function public.can_edit_own()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and (p.can_edit_own or p.role = 'admin')
  );
$$;

-- الحساب المعطَّل لا يقرأ شيئاً حتى لو بقيت جلسته مفتوحة
create or replace function public.is_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active);
$$;

revoke all on function public.is_admin(), public.can_add(),
                      public.can_edit_own(), public.is_active() from public;
grant execute on function public.is_admin(), public.can_add(),
                          public.can_edit_own(), public.is_active() to authenticated;

-- ---------------------------------------------------------------------
-- 5. تحديث updated_at تلقائياً
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists entries_touch on public.entries;
create trigger entries_touch before update on public.entries
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 6. حراسة الحقول الحسّاسة
--    يمنع أي موظف من رفع نفسه إلى أدمن أو منح نفسه صلاحيات،
--    ويمنع نسبة مادة إلى شخص آخر.
-- ---------------------------------------------------------------------
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then
    -- الأدمن لا يستطيع تجريد نفسه من الأدمن إذا كان الأخير
    if old.role = 'admin' and new.role <> 'admin'
       and (select count(*) from public.profiles where role = 'admin' and active) <= 1 then
      raise exception 'لا يمكن إزالة آخر حساب أدمن';
    end if;
    return new;
  end if;

  -- غير الأدمن: تُتجاهل كل محاولة لتغيير الدور أو الصلاحيات أو التفعيل
  new.role         := old.role;
  new.can_add      := old.can_add;
  new.can_edit_own := old.can_edit_own;
  new.can_export   := old.can_export;
  new.active       := old.active;
  new.username     := old.username;
  return new;
end;
$$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

create or replace function public.stamp_entry_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare p public.profiles%rowtype;
begin
  -- الأدمن وحده يسجّل مادة باسم شخص آخر
  if new.owner_id is distinct from auth.uid() and not public.is_admin() then
    new.owner_id := auth.uid();
  end if;

  select * into p from public.profiles where id = new.owner_id;
  if found then
    new.owner_username := p.username;
    new.owner_name     := p.full_name;
    if tg_op = 'INSERT' then new.directorate := p.directorate; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists entries_stamp on public.entries;
create trigger entries_stamp before insert or update on public.entries
  for each row execute function public.stamp_entry_owner();

-- ---------------------------------------------------------------------
-- 7. سياسات الوصول (RLS) — هنا تعيش الحماية فعلياً
-- ---------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.entries      enable row level security;
alter table public.last_reports enable row level security;

-- الحسابات: كل واحد يرى نفسه، والأدمن يرى الجميع
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete to authenticated
  using (public.is_admin() and id <> auth.uid());

-- الإدراج يتم حصراً عبر Edge Function بمفتاح الخدمة (يتخطى RLS).
-- عمداً لا توجد سياسة INSERT هنا: لا أحد ينشئ حساباً من المتصفح.

-- المواد: الموظف يرى مواده فقط. هذا هو السطر الذي يمنع التسلل.
drop policy if exists entries_select on public.entries;
create policy entries_select on public.entries for select to authenticated
  using (public.is_active() and (owner_id = auth.uid() or public.is_admin()));

drop policy if exists entries_insert on public.entries;
create policy entries_insert on public.entries for insert to authenticated
  with check (public.can_add() and (owner_id = auth.uid() or public.is_admin()));

drop policy if exists entries_update on public.entries;
create policy entries_update on public.entries for update to authenticated
  using ((owner_id = auth.uid() and public.can_edit_own()) or public.is_admin())
  with check ((owner_id = auth.uid() and public.can_edit_own()) or public.is_admin());

drop policy if exists entries_delete on public.entries;
create policy entries_delete on public.entries for delete to authenticated
  using ((owner_id = auth.uid() and public.can_edit_own()) or public.is_admin());

-- آخر تقرير
drop policy if exists reports_all on public.last_reports;
create policy reports_all on public.last_reports for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------
-- 8. لا شيء متاح لغير المسجَّلين
-- ---------------------------------------------------------------------
revoke all on public.profiles, public.entries, public.last_reports from anon;
grant select, update, delete            on public.profiles     to authenticated;
grant select, insert, update, delete    on public.entries      to authenticated;
grant select, insert, update, delete    on public.last_reports to authenticated;
