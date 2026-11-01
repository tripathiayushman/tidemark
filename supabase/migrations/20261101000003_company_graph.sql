-- Tidemark schema · part 3: the global company graph
--
-- Public records land in source_records exactly as fetched. The resolver
-- matches each record to one company (creating it if needed, recording name
-- variants as aliases), then extracts a normalized, dated signal. Workspaces
-- never write here; the worker does, with the service role.

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text generated always as (public.company_key(name)) stored,
  legal_name text,
  domain text unique,
  website text,
  description text,
  naics_code text,
  naics_title text,
  industry text,
  employee_count integer check (employee_count is null or employee_count >= 0),
  annual_revenue numeric,
  founded_year smallint,
  street text,
  city text,
  state text,
  postal_code text,
  country text not null default 'US',
  phone text,
  linkedin_url text,
  -- registry identifiers used for exact matching
  uei text unique,
  ein text,
  duns text,
  usdot_number text unique,
  is_synthetic boolean not null default false, -- demo/seed data, never real
  enrichment jsonb not null default '{}'::jsonb,
  enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index companies_name_key_trgm on public.companies using gin (name_key extensions.gin_trgm_ops);
create index companies_name_key_idx on public.companies (name_key);
create index companies_state_naics_idx on public.companies (state, naics_code);
create index companies_naics_idx on public.companies (naics_code text_pattern_ops);
create trigger companies_touch before update on public.companies
  for each row execute function public.touch_updated_at();

-- Every name a company has been seen under: legal name, DBA, subsidiary,
-- registry spelling. Lets "ACME FAB LLC" and "Acme Fabrication" resolve together.
create table public.company_aliases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  alias text not null,
  alias_key text generated always as (public.company_key(alias)) stored,
  kind text not null default 'seen_as'
    check (kind in ('legal', 'dba', 'subsidiary', 'former', 'seen_as')),
  source public.record_source,
  created_at timestamptz not null default now(),
  unique (company_id, alias_key)
);
create index company_aliases_key_trgm on public.company_aliases using gin (alias_key extensions.gin_trgm_ops);
create index company_aliases_key_idx on public.company_aliases (alias_key);

-- Raw records exactly as fetched from each dataset.
create table public.source_records (
  id uuid primary key default gen_random_uuid(),
  source public.record_source not null,
  dataset text not null default '',          -- e.g. 'chicago_building_permits'
  external_id text not null,                 -- id within that dataset
  record_type text not null,                 -- e.g. 'contract_award', 'building_permit'
  occurred_on date,
  entity_name text,
  entity_street text,
  entity_city text,
  entity_state text,
  entity_postal_code text,
  entity_identifiers jsonb not null default '{}'::jsonb, -- {uei, ein, usdot, duns, domain}
  amount numeric,
  url text,
  raw jsonb not null,
  company_id uuid references public.companies (id) on delete set null,
  match_confidence real,
  match_method text,     -- 'identifier' | 'domain' | 'exact_name' | 'fuzzy_name' | 'created'
  matched_at timestamptz,
  processed_at timestamptz,  -- signal extraction done (even if no signal produced)
  is_synthetic boolean not null default false,
  ingested_at timestamptz not null default now(),
  unique (source, dataset, external_id)
);
create index source_records_unprocessed_idx on public.source_records (ingested_at) where processed_at is null;
create index source_records_company_idx on public.source_records (company_id);

-- Normalized, dated events. One record can yield a signal; signals are what
-- the reasoning step reads as a timeline.
create table public.signals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  source_record_id uuid references public.source_records (id) on delete set null,
  category public.signal_category not null,
  signal_type text not null,   -- 'sba_504_loan', 'permit_issued', 'permit_closed', 'customs_machinery', 'supplier_switch', 'contract_award', 'fleet_growth', 'new_registration', 'facility_opening', 'press_expansion', ...
  title text not null,         -- "Building permit approved"
  detail text,                 -- "40,000 sq ft production addition at 1200 W Fulton St"
  occurred_on date not null,
  amount numeric,
  quantity numeric,
  unit text,                   -- "containers", "power units"
  location text,
  source public.record_source not null,
  source_url text,
  attributes jsonb not null default '{}'::jsonb,
  strength smallint not null default 50 check (strength between 0 and 100),
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now()
);
create index signals_company_date_idx on public.signals (company_id, occurred_on desc);
create index signals_date_idx on public.signals (occurred_on desc);
create unique index signals_record_type_uidx on public.signals (source_record_id, signal_type)
  where source_record_id is not null;

-- Point-in-time metrics (fleet size, headcount) so growth can be detected
-- across ingestion runs.
create table public.company_metrics (
  company_id uuid not null references public.companies (id) on delete cascade,
  metric text not null,          -- 'power_units', 'drivers', 'employees'
  observed_on date not null,
  value numeric not null,
  source public.record_source not null,
  primary key (company_id, metric, observed_on)
);

-- Bookkeeping for each connector run (cursor = where to resume).
create table public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source public.record_source not null,
  dataset text not null default '',
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  cursor jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  error text
);
create index ingestion_runs_source_idx on public.ingestion_runs (source, dataset, started_at desc);

-- ── Entity resolution ─────────────────────────────────────────────────────
-- Candidate companies for a raw entity, best first. The worker applies the
-- acceptance thresholds (src/lib/pipeline/resolve.ts) so they can be tuned
-- without a migration.
create or replace function public.match_company_candidates(
  p_name text,
  p_state text default null,
  p_city text default null,
  p_postal_code text default null,
  p_limit int default 5
)
returns table (company_id uuid, similarity real, same_state boolean, same_city boolean, same_zip boolean, matched_on text)
language sql
stable
set search_path = public, extensions
as $$
  with q as (select public.company_key(p_name) as k)
  , cands as (
    select c.id, extensions.similarity(c.name_key, q.k) as sim, 'name'::text as matched_on
    from public.companies c, q
    where q.k is not null and c.name_key operator(extensions.%) q.k
    union all
    select a.company_id, extensions.similarity(a.alias_key, q.k), 'alias'
    from public.company_aliases a, q
    where q.k is not null and a.alias_key operator(extensions.%) q.k
  )
  , best as (
    select distinct on (id) id, sim, matched_on from cands order by id, sim desc
  )
  select
    c.id,
    b.sim,
    (p_state is not null and upper(c.state) = upper(p_state)),
    (p_city is not null and upper(c.city) = upper(p_city)),
    (p_postal_code is not null and left(c.postal_code, 5) = left(p_postal_code, 5)),
    b.matched_on
  from best b
  join public.companies c on c.id = b.id
  order by
    b.sim
      + case when p_state is not null and upper(c.state) = upper(p_state) then 0.05 else 0 end
      + case when p_postal_code is not null and left(c.postal_code, 5) = left(p_postal_code, 5) then 0.05 else 0 end
      desc
  limit p_limit;
$$;
