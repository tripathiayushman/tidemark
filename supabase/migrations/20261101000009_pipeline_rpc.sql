-- Tidemark schema · part 9: pipeline helpers (service role only)

-- Titles the research step says to contact for this account's reason.
alter table public.accounts add column target_roles text[] not null default '{}';

-- Companies with recent signals that pass an ICP's coarse filters.
-- Companies with unknown NAICS are included (ranked after known matches) so
-- records from permits / fleet data without industry codes still surface;
-- the fit score sorts them out.
create or replace function public.candidate_companies(
  p_since date,
  p_naics_prefixes text[] default null,
  p_states text[] default null,
  p_exclude_states text[] default null,
  p_limit int default 500
)
returns table (company_id uuid, signal_count int, last_signal date, naics_known boolean)
language sql
stable
set search_path = public
as $$
  with recent as (
    select s.company_id, count(*)::int as n, max(s.occurred_on) as last_on
    from signals s
    where s.occurred_on >= p_since
    group by s.company_id
  )
  select c.id, r.n, r.last_on, c.naics_code is not null
  from recent r
  join companies c on c.id = r.company_id
  where (p_states is null or cardinality(p_states) = 0 or upper(c.state) = any (p_states))
    and (p_exclude_states is null or c.state is null or not (upper(c.state) = any (p_exclude_states)))
    and (
      p_naics_prefixes is null or cardinality(p_naics_prefixes) = 0
      or c.naics_code is null
      or exists (select 1 from unnest(p_naics_prefixes) p where c.naics_code like p || '%')
    )
  order by (c.naics_code is not null) desc, r.n desc, r.last_on desc
  limit p_limit;
$$;

-- Accounts whose company gained signals since the last research pass.
create or replace function public.accounts_needing_research(p_limit int default 200)
returns table (account_id uuid, workspace_id uuid)
language sql
stable
set search_path = public
as $$
  select a.id, a.workspace_id
  from accounts a
  where a.research_status not in ('queued', 'researching', 'checking')
    and exists (
      select 1 from signals s
      where s.company_id = a.company_id
        and s.created_at > coalesce(a.last_researched_at, 'epoch'::timestamptz)
    )
  order by a.last_researched_at nulls first
  limit p_limit;
$$;

revoke execute on function public.candidate_companies(date, text[], text[], text[], int) from public, anon, authenticated;
revoke execute on function public.accounts_needing_research(int) from public, anon, authenticated;
grant execute on function public.candidate_companies(date, text[], text[], text[], int) to service_role;
grant execute on function public.accounts_needing_research(int) to service_role;
