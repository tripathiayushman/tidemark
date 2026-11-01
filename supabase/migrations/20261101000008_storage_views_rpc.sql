-- Tidemark schema · part 8: storage, views and read RPCs

-- ── Storage: knowledge-base files at knowledge/<workspace_id>/<doc_id>/<name>
insert into storage.buckets (id, name, public, file_size_limit)
values ('knowledge', 'knowledge', false, 52428800) -- 50 MB per file
on conflict (id) do nothing;

create policy knowledge_member_read on storage.objects for select to authenticated
  using (bucket_id = 'knowledge' and public.is_workspace_member(((storage.foldername(name))[1])::uuid));
create policy knowledge_member_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'knowledge' and public.is_workspace_member(((storage.foldername(name))[1])::uuid));
create policy knowledge_member_delete on storage.objects for delete to authenticated
  using (bucket_id = 'knowledge' and public.is_workspace_member(((storage.foldername(name))[1])::uuid));

-- ── Prospects view: one row per account with the columns the list shows.
-- security_invoker so the caller's RLS applies.
create or replace view public.prospect_rows
with (security_invoker = true)
as
select
  a.id,
  a.workspace_id,
  a.company_id,
  a.icp_id,
  i.name as icp_name,
  c.name as company_name,
  c.domain,
  c.industry,
  c.naics_title,
  c.city,
  c.state,
  c.employee_count,
  c.is_synthetic,
  a.research_status,
  a.status,
  a.tier,
  a.score,
  a.fit_score,
  a.activity_score,
  a.confidence,
  a.reason_to_buy,
  a.reason_category,
  a.timing_label,
  a.readiness,
  a.contact_window_start,
  a.contact_window_end,
  a.owner_id,
  a.qualified_at,
  a.last_signal_on,
  a.updated_at,
  top_contact.id as top_contact_id,
  top_contact.full_name as top_contact_name,
  top_contact.title as top_contact_title,
  coalesce(wp.paths, 0) as warm_path_count,
  wp.best_explanation as warm_path_explanation,
  coalesce(ev.evidence, 0) as evidence_count
from public.accounts a
join public.companies c on c.id = a.company_id
left join public.icps i on i.id = a.icp_id
left join lateral (
  select ct.id, ct.full_name, ct.title
  from public.contacts ct
  where ct.account_id = a.id
  order by (ct.role_tag = 'decision_maker') desc, (ct.email_status = 'valid') desc, ct.created_at
  limit 1
) top_contact on true
left join lateral (
  select count(*)::int as paths,
         (array_agg(w.explanation order by w.strength desc))[1] as best_explanation
  from public.warm_paths w where w.account_id = a.id
) wp on true
left join lateral (
  select count(*)::int as evidence from public.account_evidence e where e.account_id = a.id
) ev on true;

-- ── Knowledge base search (hybrid: full-text + optional vector) ───────────
create or replace function public.search_kb(
  p_workspace_id uuid,
  p_query text,
  p_embedding extensions.vector(1024) default null,
  p_limit int default 8
)
returns table (chunk_id bigint, document_id uuid, document_name text, content text, rank real)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with fts as (
    select k.id, ts_rank_cd(k.tsv, websearch_to_tsquery('english', p_query)) as r
    from public.kb_chunks k
    where k.workspace_id = p_workspace_id
      and k.tsv @@ websearch_to_tsquery('english', p_query)
    order by r desc
    limit p_limit * 3
  ),
  vec as (
    select k.id, (1 - (k.embedding <=> p_embedding))::real as r
    from public.kb_chunks k
    where p_embedding is not null and k.workspace_id = p_workspace_id and k.embedding is not null
    order by k.embedding <=> p_embedding
    limit p_limit * 3
  ),
  merged as (
    select id, sum(r)::real as r from (
      select id, r from fts
      union all
      select id, r from vec
    ) u group by id
  )
  select k.id, k.document_id, d.name, k.content, m.r
  from merged m
  join public.kb_chunks k on k.id = m.id
  join public.kb_documents d on d.id = k.document_id
  order by m.r desc
  limit p_limit;
$$;

-- ── Workspace stats for Home / Insights ───────────────────────────────────
create or replace function public.workspace_stats(p_workspace_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'watched', (select count(*) from accounts where workspace_id = p_workspace_id),
    'researching', (select count(*) from accounts where workspace_id = p_workspace_id and research_status in ('queued', 'researching', 'checking')),
    'qualified', (select count(*) from accounts where workspace_id = p_workspace_id and research_status = 'qualified'),
    'new_this_week', (select count(*) from accounts where workspace_id = p_workspace_id and research_status = 'qualified' and qualified_at > now() - interval '7 days'),
    'tier_counts', (
      select coalesce(jsonb_object_agg(tier, n), '{}'::jsonb) from (
        select tier, count(*) n from accounts
        where workspace_id = p_workspace_id and research_status = 'qualified' and tier is not null
        group by tier
      ) t),
    'windows_closing', (
      select count(*) from accounts
      where workspace_id = p_workspace_id and research_status = 'qualified'
        and contact_window_end between current_date and current_date + 14),
    'open_tasks', (select count(*) from tasks where workspace_id = p_workspace_id and status = 'open'),
    'with_warm_path', (
      select count(distinct account_id) from warm_paths where workspace_id = p_workspace_id),
    'signals_by_category', (
      select coalesce(jsonb_object_agg(category, n), '{}'::jsonb) from (
        select s.category, count(*) n
        from account_evidence e join signals s on s.id = e.signal_id
        where e.workspace_id = p_workspace_id
        group by s.category
      ) t),
    'kb_bytes', (select coalesce(sum(size_bytes), 0) from kb_documents where workspace_id = p_workspace_id),
    'kb_quota', (select kb_quota_bytes from workspaces where id = p_workspace_id)
  );
$$;
