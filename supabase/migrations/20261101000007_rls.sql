-- Tidemark schema · part 7: row-level security
--
-- Model: a signed-in user sees a workspace's rows iff they are a member.
-- The global company graph is readable by any signed-in user (it is built
-- from public records) and writable only by the service role (worker).
-- Rows the worker owns (chunks, evidence, warm paths, synced mail) are
-- read-only to clients.

-- Enable RLS everywhere in public.
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ── Global graph: read-only for authenticated users ───────────────────────
do $$
declare t text;
begin
  foreach t in array array['companies', 'company_aliases', 'source_records', 'signals', 'company_metrics', 'ingestion_runs']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_read', t);
  end loop;
end $$;

-- ── Tenancy ───────────────────────────────────────────────────────────────
create policy profiles_read on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.workspace_members me
      join public.workspace_members them on them.workspace_id = me.workspace_id
      where me.user_id = (select auth.uid()) and them.user_id = profiles.id
    )
  );
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy workspaces_read on public.workspaces for select to authenticated
  using (public.is_workspace_member(id));
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.is_workspace_admin(id)) with check (public.is_workspace_admin(id));
-- inserts go through create_workspace(); deletes are owner-only via the app.

create policy members_read on public.workspace_members for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy members_update on public.workspace_members for update to authenticated
  using (public.is_workspace_admin(workspace_id)) with check (public.is_workspace_admin(workspace_id) and role <> 'owner');
create policy members_delete on public.workspace_members for delete to authenticated
  using ((public.is_workspace_admin(workspace_id) and role <> 'owner') or user_id = (select auth.uid()));

create policy invites_admin_all on public.workspace_invites for all to authenticated
  using (public.is_workspace_admin(workspace_id)) with check (public.is_workspace_admin(workspace_id));

-- ── Member CRUD tables ────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'seller_profiles', 'kb_documents', 'icps', 'accounts', 'contacts',
    'tasks', 'lists', 'list_members', 'custom_columns', 'account_field_values',
    'campaigns', 'campaign_steps', 'campaign_enrollments'
  ]
  loop
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (public.is_workspace_member(workspace_id))
         with check (public.is_workspace_member(workspace_id))',
      t || '_member_all', t);
  end loop;
end $$;

-- ── Member read-only tables (written by the worker / server) ──────────────
do $$
declare t text;
begin
  foreach t in array array[
    'kb_chunks', 'account_evidence', 'warm_paths', 'crm_links',
    'email_messages', 'meetings', 'jobs'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (public.is_workspace_member(workspace_id))',
      t || '_member_read', t);
  end loop;
end $$;

-- Activities: read all, add your own notes.
create policy activities_read on public.activities for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy activities_insert on public.activities for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and actor_id = (select auth.uid()));

-- Network: everyone sees the team's network (that's how warm paths work);
-- members add/remove only their own connections.
create policy network_read on public.network_connections for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy network_write_own on public.network_connections for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and member_id = (select auth.uid()));
create policy network_delete_own on public.network_connections for delete to authenticated
  using (public.is_workspace_member(workspace_id) and member_id = (select auth.uid()));

-- Insights: read + dismiss.
create policy insights_read on public.insights for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy insights_dismiss on public.insights for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

-- Campaign messages: read, and edit drafts before they send.
create policy campaign_messages_read on public.campaign_messages for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy campaign_messages_edit_draft on public.campaign_messages for update to authenticated
  using (public.is_workspace_member(workspace_id) and status in ('draft', 'scheduled'))
  with check (public.is_workspace_member(workspace_id) and status in ('draft', 'scheduled', 'skipped'));

-- Suppressions: members read/add; admins remove.
create policy suppressions_read on public.suppressions for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy suppressions_insert on public.suppressions for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy suppressions_delete on public.suppressions for delete to authenticated
  using (public.is_workspace_admin(workspace_id));

-- Chat is private to the user who started the thread.
create policy chat_threads_own on public.chat_threads for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy chat_messages_own on public.chat_messages for select to authenticated
  using (exists (
    select 1 from public.chat_threads t
    where t.id = chat_messages.thread_id and t.user_id = (select auth.uid())
  ));

-- Integrations: members see connections; the connector or an admin can
-- change/remove them. Creation happens server-side after OAuth.
create policy connections_read on public.integration_connections for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy connections_update on public.integration_connections for update to authenticated
  using (public.is_workspace_admin(workspace_id) or connected_by = (select auth.uid()))
  with check (public.is_workspace_member(workspace_id));
create policy connections_delete on public.integration_connections for delete to authenticated
  using (public.is_workspace_admin(workspace_id) or connected_by = (select auth.uid()));

-- integration_secrets and scheduled_runs: RLS on, no policies → service role only.
