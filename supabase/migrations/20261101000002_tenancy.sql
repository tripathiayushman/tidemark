-- Tidemark schema · part 2: users, workspaces, membership

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email extensions.citext,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  website text,
  timezone text not null default 'America/New_York',
  -- onboarding progress: company → knowledge → icp → done
  onboarding_step text not null default 'company'
    check (onboarding_step in ('company', 'knowledge', 'icp', 'done')),
  settings jsonb not null default '{}'::jsonb,
  kb_quota_bytes bigint not null default 1073741824, -- 1 GB
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email extensions.citext not null,
  role public.member_role not null default 'member' check (role <> 'owner'),
  token uuid not null unique default gen_random_uuid(),
  invited_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger workspaces_touch before update on public.workspaces
  for each row execute function public.touch_updated_at();

-- ── Membership helpers (SECURITY DEFINER so RLS policies can call them
--    without recursing into workspace_members' own policies) ───────────────
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_workspace_admin(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

-- New auth user → profile row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Create a workspace and make the caller its owner, atomically.
create or replace function public.create_workspace(p_name text, p_website text default null)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_base text;
  v_slug text;
  v_ws public.workspaces;
  v_try int := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  v_base := trim(both '-' from regexp_replace(lower(coalesce(p_name, 'workspace')), '[^a-z0-9]+', '-', 'g'));
  if char_length(v_base) < 2 then v_base := 'workspace'; end if;
  v_base := left(v_base, 48);
  v_slug := v_base;

  loop
    begin
      insert into public.workspaces (name, slug, website, created_by)
      values (p_name, v_slug, nullif(btrim(p_website), ''), v_uid)
      returning * into v_ws;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      v_slug := v_base || '-' || substr(md5(random()::text), 1, 5);
      if v_try > 5 then raise; end if;
    end;
  end loop;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_ws.id, v_uid, 'owner');

  return v_ws;
end;
$$;

-- Accept an invite addressed to the caller's email.
create or replace function public.accept_workspace_invite(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_inv public.workspace_invites;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select email into v_email from auth.users where id = v_uid;

  select * into v_inv from public.workspace_invites
  where token = p_token and accepted_at is null and expires_at > now();
  if not found then
    raise exception 'invite not found or expired' using errcode = 'P0002';
  end if;
  if lower(v_inv.email::text) <> lower(v_email) then
    raise exception 'invite was sent to a different email' using errcode = '42501';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_inv.workspace_id, v_uid, v_inv.role)
  on conflict (workspace_id, user_id) do nothing;

  update public.workspace_invites set accepted_at = now() where id = v_inv.id;
  return v_inv.workspace_id;
end;
$$;

revoke execute on function public.create_workspace(text, text) from public, anon;
revoke execute on function public.accept_workspace_invite(uuid) from public, anon;
grant execute on function public.create_workspace(text, text) to authenticated;
grant execute on function public.accept_workspace_invite(uuid) to authenticated;
