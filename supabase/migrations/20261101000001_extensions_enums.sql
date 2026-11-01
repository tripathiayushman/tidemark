-- Tidemark schema · part 1: extensions, enums, shared helpers
--
-- Layout of the data model:
--   * Company graph (global, shared by every workspace): companies, aliases,
--     raw source_records from public datasets, normalized dated signals.
--   * Workspace data (tenant-scoped, RLS): knowledge base, ICPs, accounts
--     (a company evaluated against a workspace's ICP), evidence, contacts,
--     warm paths, tasks, lists, chat.
--   * Outreach + integrations (tenant-scoped): CRM links, Gmail/Granola
--     syncs, campaigns, suppressions. OAuth secrets live in a table that only
--     the service role can read.
--   * Jobs: a Postgres-backed queue drained by the worker.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists vector with schema extensions;

-- ── Enums ──────────────────────────────────────────────────────────────────
create type public.member_role as enum ('owner', 'admin', 'member');

create type public.signal_category as enum (
  'money_moving',      -- loans funding buildings / equipment
  'building',          -- permits filed or closed out, facilities opening
  'equipment_supply',  -- machines through customs, supplier switches
  'contracts',         -- large contract awards
  'operations'         -- fleet growth, new registrations / states
);

create type public.record_source as enum (
  'usaspending', 'sba', 'permits', 'fmcsa', 'osha', 'customs',
  'website', 'press', 'licensed', 'manual', 'seed'
);

create type public.research_status as enum (
  'queued', 'researching', 'checking', 'qualified', 'not_now', 'disqualified', 'error'
);

create type public.account_tier as enum ('S', 'A', 'B', 'C');

create type public.account_status as enum (
  'prospect', 'contacted', 'engaged', 'meeting', 'opportunity', 'customer', 'lost', 'archived'
);

create type public.readiness as enum ('ready_now', 'warming', 'later');
create type public.confidence_level as enum ('low', 'medium', 'high');

create type public.contact_role_tag as enum (
  'decision_maker', 'runs_the_build', 'champion', 'influencer', 'other'
);

create type public.verification_status as enum ('unverified', 'valid', 'risky', 'invalid');

create type public.kb_kind as enum ('upload', 'website', 'note');
create type public.kb_status as enum ('queued', 'processing', 'ready', 'failed');

create type public.task_kind as enum ('reach_out', 'follow_up', 'review', 'research', 'custom');
create type public.task_status as enum ('open', 'done', 'dismissed');

create type public.integration_provider as enum ('hubspot', 'attio', 'gmail', 'granola', 'instantly');
create type public.connection_status as enum ('active', 'error', 'disconnected');

create type public.network_source as enum ('gmail', 'linkedin_export', 'hubspot', 'attio', 'granola', 'manual');

create type public.campaign_channel as enum ('gmail', 'instantly');
create type public.campaign_status as enum ('draft', 'active', 'paused', 'completed', 'archived');
create type public.enrollment_status as enum (
  'active', 'completed', 'stopped_reply', 'stopped_bounce', 'stopped_unsubscribe', 'stopped_manual', 'failed'
);
create type public.message_status as enum ('draft', 'scheduled', 'sending', 'sent', 'failed', 'bounced', 'skipped');

create type public.job_status as enum ('queued', 'running', 'done', 'failed', 'cancelled');

-- ── Helpers ────────────────────────────────────────────────────────────────

-- Keeps updated_at honest on every table that has one.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Canonical company-name form used for entity resolution. Strips punctuation,
-- legal suffixes and "the", collapses whitespace. IMMUTABLE so it can back a
-- generated column; keep src/lib/pipeline/normalize.ts in sync with it.
create or replace function public.normalize_company_name(raw text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              lower(coalesce(raw, '')),
              '\s+(d/?b/?a|aka)\s+.*$', '', 'g'),            -- drop "dba ..." tails
            '&', ' and ', 'g'),
          '[^a-z0-9 ]', ' ', 'g'),                            -- punctuation → space
        '(^|\s)(the|inc|incorporated|llc|l l c|llp|lp|ltd|limited|corp|corporation|co|company|plc|pc|pllc|holdings|group)(?=\s|$)',
        ' ', 'g')
    ),
    ''
  );
$$;

-- regexp_replace above can leave runs of spaces; collapse them in a wrapper so
-- the generated columns get a single canonical form.
create or replace function public.company_key(raw text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(public.normalize_company_name(raw), '\s+', ' ', 'g')), '');
$$;

-- Lowercased bare domain ("https://www.Acme.com/about" → "acme.com").
create or replace function public.normalize_domain(raw text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(
    regexp_replace(
      regexp_replace(lower(btrim(coalesce(raw, ''))), '^[a-z]+://', ''),
      '^www\.|[/?#:].*$', '', 'g'),
    '');
$$;
