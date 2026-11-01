-- Tidemark schema · part 6: background job queue
--
-- The worker (POST /api/worker/tick, or `npm run worker`) claims jobs with
-- FOR UPDATE SKIP LOCKED, so several workers can drain the queue safely.
-- Only the service role can claim or complete jobs.

create table public.jobs (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.job_status not null default 'queued',
  priority smallint not null default 100,       -- lower runs first
  attempts smallint not null default 0,
  max_attempts smallint not null default 3,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  dedupe_key text,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_ready_idx on public.jobs (priority, run_after) where status = 'queued';
create index jobs_ws_idx on public.jobs (workspace_id, created_at desc);
-- At most one live job per dedupe key.
create unique index jobs_dedupe_live_uidx on public.jobs (dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');

-- Periodic-schedule ledger: one row per (schedule, time bucket).
create table public.scheduled_runs (
  key text primary key,
  created_at timestamptz not null default now()
);

create or replace function public.enqueue_job(
  p_kind text,
  p_payload jsonb default '{}'::jsonb,
  p_workspace_id uuid default null,
  p_dedupe_key text default null,
  p_run_after timestamptz default now(),
  p_priority smallint default 100,
  p_max_attempts smallint default 3
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.jobs (kind, payload, workspace_id, dedupe_key, run_after, priority, max_attempts)
  values (p_kind, coalesce(p_payload, '{}'::jsonb), p_workspace_id, p_dedupe_key, coalesce(p_run_after, now()), p_priority, p_max_attempts)
  on conflict (dedupe_key) where dedupe_key is not null and status in ('queued', 'running')
  do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.claim_jobs(
  p_worker text,
  p_limit int default 5,
  p_kinds text[] default null
)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Recover jobs whose worker died mid-run.
  update public.jobs
     set status = 'queued', locked_at = null, locked_by = null,
         last_error = coalesce(last_error, 'lease expired')
   where status = 'running' and locked_at < now() - interval '15 minutes';

  return query
  update public.jobs j
     set status = 'running',
         locked_at = now(),
         locked_by = p_worker,
         attempts = j.attempts + 1,
         started_at = now()
   where j.id in (
     select id from public.jobs
      where status = 'queued'
        and run_after <= now()
        and (p_kinds is null or kind = any (p_kinds))
      order by priority, run_after
      for update skip locked
      limit greatest(p_limit, 1)
   )
  returning j.*;
end;
$$;

create or replace function public.complete_job(p_id bigint, p_result jsonb default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.jobs
     set status = 'done', result = p_result, finished_at = now(), locked_at = null, locked_by = null
   where id = p_id;
$$;

-- Failed attempts back off exponentially (1, 4, 9… minutes) until max_attempts.
create or replace function public.fail_job(p_id bigint, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.jobs
     set status = case when attempts >= max_attempts then 'failed'::public.job_status else 'queued'::public.job_status end,
         last_error = left(p_error, 4000),
         run_after = now() + make_interval(mins => attempts * attempts),
         finished_at = case when attempts >= max_attempts then now() else null end,
         locked_at = null,
         locked_by = null
   where id = p_id;
$$;

revoke execute on function public.enqueue_job(text, jsonb, uuid, text, timestamptz, smallint, smallint) from public, anon, authenticated;
revoke execute on function public.claim_jobs(text, int, text[]) from public, anon, authenticated;
revoke execute on function public.complete_job(bigint, jsonb) from public, anon, authenticated;
revoke execute on function public.fail_job(bigint, text) from public, anon, authenticated;
grant execute on function public.enqueue_job(text, jsonb, uuid, text, timestamptz, smallint, smallint) to service_role;
grant execute on function public.claim_jobs(text, int, text[]) to service_role;
grant execute on function public.complete_job(bigint, jsonb) to service_role;
grant execute on function public.fail_job(bigint, text) to service_role;
