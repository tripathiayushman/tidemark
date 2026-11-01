-- Tidemark schema · part 4: workspace-scoped data
-- Knowledge base, seller profile, ICPs, accounts + evidence, contacts,
-- network/warm paths, tasks, lists + custom columns, activity, chat, insights.

-- ── Knowledge ─────────────────────────────────────────────────────────────
-- What the workspace sells, distilled from its site + documents.
create table public.seller_profiles (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  summary text,                    -- one-paragraph "what we sell, to whom"
  offerings jsonb not null default '[]'::jsonb,       -- [{name, description}]
  buyer_problems jsonb not null default '[]'::jsonb,  -- [string]
  proof_points jsonb not null default '[]'::jsonb,    -- [string]
  differentiators jsonb not null default '[]'::jsonb, -- [string]
  competitors jsonb not null default '[]'::jsonb,     -- [string]
  buying_triggers jsonb not null default '[]'::jsonb, -- [string] events that create need
  updated_at timestamptz not null default now()
);

create table public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  kind public.kb_kind not null default 'upload',
  source_url text,
  storage_path text,              -- knowledge/<workspace>/<doc>/<file>
  mime_type text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  status public.kb_status not null default 'queued',
  error text,
  column_count integer,           -- for CSV/XLSX
  row_count integer,
  char_count integer,
  summary text,
  created_by uuid references auth.users (id) on delete set null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index kb_documents_ws_idx on public.kb_documents (workspace_id, created_at desc);
create trigger kb_documents_touch before update on public.kb_documents
  for each row execute function public.touch_updated_at();

create table public.kb_chunks (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  document_id uuid not null references public.kb_documents (id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  tsv tsvector generated always as (to_tsvector('english', content)) stored,
  embedding extensions.vector(1024),  -- optional (Voyage); FTS works without it
  unique (document_id, chunk_index)
);
create index kb_chunks_ws_idx on public.kb_chunks (workspace_id);
create index kb_chunks_tsv_idx on public.kb_chunks using gin (tsv);
create index kb_chunks_embedding_idx on public.kb_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- ── ICPs / segments ───────────────────────────────────────────────────────
-- criteria:          {industries:[{naics_prefix,label}], keywords:[], exclude_keywords:[],
--                     employee_min, employee_max, revenue_min, revenue_max,
--                     states:[], exclude_states:[]}
-- buyer_roles:       [{title, role_tag, seniority, departments:[], title_keywords:[]}]
-- signal_preferences:{weights:{money_moving..operations: 0..2}, lookback_days, min_corroborating}
create table public.icps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,                     -- "Mid-market"
  description text,
  is_primary boolean not null default false,
  is_active boolean not null default true,
  criteria jsonb not null default '{}'::jsonb,
  buyer_roles jsonb not null default '[]'::jsonb,
  signal_preferences jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index icps_one_primary_uidx on public.icps (workspace_id) where is_primary;
create trigger icps_touch before update on public.icps
  for each row execute function public.touch_updated_at();

-- ── Accounts: a company evaluated against a workspace ─────────────────────
-- research_status drives the "watching" table (Researching… / Checking… / Yes);
-- qualified accounts are the Prospects list.
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  icp_id uuid references public.icps (id) on delete set null,
  research_status public.research_status not null default 'queued',
  -- scores (0..100)
  fit_score smallint check (fit_score between 0 and 100),
  fit_breakdown jsonb,          -- [{criterion, score, weight, note}]
  activity_score smallint check (activity_score between 0 and 100),
  activity_breakdown jsonb,
  score smallint check (score between 0 and 100),
  tier public.account_tier,
  confidence public.confidence_level,
  -- the reasoning output
  reason_to_buy text,           -- "Opening a second production floor"
  reason_category text,         -- expansion | new_line | relocation | new_contract | retooling | fleet_growth | supplier_change | other
  why text,                     -- 1-2 sentences tying records to what we sell
  reasoning text,               -- "Reading the timeline" narrative
  timing_label text,            -- "Expansion, next 90 days"
  readiness public.readiness,
  contact_window_start date,
  contact_window_end date,
  next_step text,
  -- pipeline state
  status public.account_status not null default 'prospect',
  owner_id uuid references auth.users (id) on delete set null,
  qualified_at timestamptz,      -- first qualification → "New this week"
  last_researched_at timestamptz,
  last_signal_on date,
  signals_fingerprint text,      -- skip re-research when nothing changed
  research_error text,
  research_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, company_id),
  check (contact_window_end is null or contact_window_start is null or contact_window_end >= contact_window_start)
);
create index accounts_ws_status_idx on public.accounts (workspace_id, research_status);
create index accounts_ws_score_idx on public.accounts (workspace_id, score desc nulls last);
create index accounts_ws_qualified_idx on public.accounts (workspace_id, qualified_at desc);
create index accounts_company_idx on public.accounts (company_id);
create trigger accounts_touch before update on public.accounts
  for each row execute function public.touch_updated_at();

-- "Records behind it": which signals support the reason, with a note on each.
create table public.account_evidence (
  account_id uuid not null references public.accounts (id) on delete cascade,
  signal_id uuid not null references public.signals (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  note text not null,
  position smallint not null default 0,
  primary key (account_id, signal_id)
);
create index account_evidence_ws_idx on public.account_evidence (workspace_id);

-- ── People ────────────────────────────────────────────────────────────────
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  company_id uuid references public.companies (id) on delete set null,
  account_id uuid references public.accounts (id) on delete set null,
  full_name text not null,
  first_name text,
  last_name text,
  title text,
  seniority text,       -- owner | c_suite | vp | director | manager | staff
  department text,
  role_tag public.contact_role_tag not null default 'other',
  email extensions.citext,
  email_status public.verification_status not null default 'unverified',
  email_verified_at timestamptz,
  phone text,
  phone_status public.verification_status not null default 'unverified',
  linkedin_url text,
  location text,
  source text not null default 'manual',  -- apollo | pdl | hunter | seed | manual | hubspot | attio | chat
  source_ref text,
  notes text,
  unsubscribed_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index contacts_ws_email_uidx on public.contacts (workspace_id, email) where email is not null;
create index contacts_account_idx on public.contacts (account_id);
create trigger contacts_touch before update on public.contacts
  for each row execute function public.touch_updated_at();

-- The team's own network: people members know, from Gmail, a LinkedIn
-- connections export, CRM records or meetings. Basis for warm paths.
create table public.network_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  member_id uuid not null references auth.users (id) on delete cascade,
  full_name text not null,
  email extensions.citext,
  title text,
  company_name text,
  company_domain text,
  company_id uuid references public.companies (id) on delete set null,
  linkedin_url text,
  source public.network_source not null,
  interactions integer not null default 0,
  last_interaction_at timestamptz,
  connected_on date,
  -- email, else LinkedIn URL, else lowercased name (computed by the app so
  -- upserts can target a plain unique constraint)
  identity_key text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, member_id, source, identity_key)
);
create index network_connections_company_idx on public.network_connections (workspace_id, company_id);
create index network_connections_domain_idx on public.network_connections (workspace_id, company_domain);

create table public.warm_paths (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  connection_id uuid not null references public.network_connections (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  member_id uuid not null references auth.users (id) on delete cascade,
  path_type text not null
    check (path_type in ('works_there', 'is_the_contact', 'emailed_company', 'met_company', 'former_colleague')),
  strength smallint not null default 50 check (strength between 0 and 100),
  explanation text not null,      -- "Intro via Sam Ortiz (Plant Controller) · Dana knows Sam from Gmail"
  created_at timestamptz not null default now()
);
create unique index warm_paths_uidx on public.warm_paths (account_id, connection_id);
create index warm_paths_ws_idx on public.warm_paths (workspace_id);

-- ── Work ──────────────────────────────────────────────────────────────────
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_id uuid references public.accounts (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  assignee_id uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  title text not null,
  description text,
  kind public.task_kind not null default 'custom',
  status public.task_status not null default 'open',
  due_on date,
  source text not null default 'user' check (source in ('user', 'system', 'chat')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_ws_status_idx on public.tasks (workspace_id, status, due_on);
create unique index tasks_system_dedupe_uidx on public.tasks (account_id, kind)
  where source = 'system' and status = 'open';
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

create table public.lists (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  description text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create table public.list_members (
  list_id uuid not null references public.lists (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_id, account_id)
);

-- User-defined columns on the prospects table (sync to CRM as properties).
create table public.custom_columns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  data_type text not null default 'text'
    check (data_type in ('text', 'number', 'date', 'boolean', 'select', 'url')),
  options jsonb not null default '[]'::jsonb,
  ai_prompt text,        -- optional: fill each row by asking Claude
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  unique (workspace_id, key)
);

create table public.account_field_values (
  account_id uuid not null references public.accounts (id) on delete cascade,
  column_id uuid not null references public.custom_columns (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  value jsonb,
  updated_at timestamptz not null default now(),
  primary key (account_id, column_id)
);

-- Timeline of everything that happened on an account.
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_id uuid references public.accounts (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  actor_id uuid references auth.users (id) on delete set null,
  kind text not null,   -- status_change | note | qualified | crm_push | campaign_enrolled | email_sent | reply | meeting | task_done
  title text not null,
  body text,
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index activities_account_idx on public.activities (account_id, occurred_at desc);
create index activities_ws_idx on public.activities (workspace_id, occurred_at desc);

-- ── Chat ──────────────────────────────────────────────────────────────────
create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index chat_threads_user_idx on public.chat_threads (workspace_id, user_id, updated_at desc);
create trigger chat_threads_touch before update on public.chat_threads
  for each row execute function public.touch_updated_at();

-- Append-only. `content` holds the exact Anthropic content blocks (including
-- thinking + tool_use/tool_result) so history replays byte-identical.
create table public.chat_messages (
  id bigint generated always as identity primary key,
  thread_id uuid not null references public.chat_threads (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null,
  display_text text,
  created_at timestamptz not null default now()
);
create index chat_messages_thread_idx on public.chat_messages (thread_id, id);

-- Generated observations for the Insights page (targeting gaps etc.).
create table public.insights (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null,   -- targeting_gap | segment_performance | window_closing | coverage
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  dismissed_at timestamptz
);
create index insights_ws_idx on public.insights (workspace_id, generated_at desc);
