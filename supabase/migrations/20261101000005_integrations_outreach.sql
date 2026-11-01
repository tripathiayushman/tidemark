-- Tidemark schema · part 5: integrations and outreach
--
-- Rules carried from the product spec:
--   * CRM sync (HubSpot, Attio) adds/updates, never deletes remote records.
--   * Gmail and Granola are read-only; disconnecting Gmail deletes every
--     synced email (FK cascade from integration_connections). Granola meetings
--     cascade the same way.
--   * Gmail campaign sending: off until enabled, weekdays, inside sending
--     hours, at most 40/day per mailbox, unsubscribe link in every email,
--     sequence stops on reply / bounce / unsubscribe.
--   * Instantly: only admins connect; Tidemark never sends through it, it
--     adds leads with a drafted first email and reads back outcomes.

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider public.integration_provider not null,
  status public.connection_status not null default 'active',
  account_label text,            -- mailbox address, HubSpot portal name, ...
  external_account_id text not null default '',  -- portal id / workspace id / mailbox
  scopes text[] not null default '{}',
  -- per-provider settings, e.g. gmail: {sending_enabled, send_window:{...}, prospect_scope}
  settings jsonb not null default '{}'::jsonb,
  connected_by uuid references auth.users (id) on delete set null,
  last_synced_at timestamptz,
  sync_cursor jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider, external_account_id)
);
create trigger integration_connections_touch before update on public.integration_connections
  for each row execute function public.touch_updated_at();

-- Encrypted OAuth tokens / API keys (AES-256-GCM, key held by the app).
-- RLS is enabled with NO policies: only the service role can read this.
create table public.integration_secrets (
  connection_id uuid primary key references public.integration_connections (id) on delete cascade,
  ciphertext text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Local ↔ remote ids for CRM sync.
create table public.crm_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null references public.integration_connections (id) on delete cascade,
  object_type text not null check (object_type in ('company', 'person', 'list', 'property')),
  local_id uuid,                 -- accounts.id / contacts.id / lists.id / custom_columns.id
  remote_id text not null,
  remote_updated_at timestamptz,
  last_pushed_at timestamptz,
  last_pulled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (connection_id, object_type, local_id),
  unique (connection_id, object_type, remote_id)
);

-- Gmail threads with chosen prospects (read-only mirror).
create table public.email_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null references public.integration_connections (id) on delete cascade,
  gmail_message_id text not null,
  gmail_thread_id text not null,
  account_id uuid references public.accounts (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_email extensions.citext,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  subject text,
  snippet text,
  body_text text,
  sent_at timestamptz,
  labels text[] not null default '{}',
  is_bounce boolean not null default false,
  created_at timestamptz not null default now(),
  unique (connection_id, gmail_message_id)
);
create index email_messages_account_idx on public.email_messages (account_id, sent_at desc);
create index email_messages_thread_idx on public.email_messages (connection_id, gmail_thread_id);

-- Granola meetings where a prospect attended (read-only mirror).
create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null references public.integration_connections (id) on delete cascade,
  external_id text not null,
  title text,
  started_at timestamptz,
  ended_at timestamptz,
  attendees jsonb not null default '[]'::jsonb,   -- [{name, email}]
  ai_notes text,
  transcript text,
  account_id uuid references public.accounts (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (connection_id, external_id)
);
create index meetings_account_idx on public.meetings (account_id, started_at desc);

-- ── Campaigns ─────────────────────────────────────────────────────────────
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  channel public.campaign_channel not null,
  status public.campaign_status not null default 'draft',
  mailbox_connection_id uuid references public.integration_connections (id) on delete set null, -- gmail
  instantly_connection_id uuid references public.integration_connections (id) on delete set null,
  instantly_campaign_id text,
  sending_days smallint[] not null default '{1,2,3,4,5}'
    check (sending_days <@ '{1,2,3,4,5}'::smallint[]),           -- ISO weekday, weekdays only
  send_window_start time not null default '09:00',
  send_window_end time not null default '17:00',
  timezone text not null default 'America/New_York',
  daily_cap smallint not null default 40 check (daily_cap between 1 and 40),
  created_by uuid references auth.users (id) on delete set null,
  launched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (send_window_end > send_window_start)
);
create trigger campaigns_touch before update on public.campaigns
  for each row execute function public.touch_updated_at();

create table public.campaign_steps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  position smallint not null check (position >= 0),
  delay_days smallint not null default 3 check (delay_days >= 0),
  subject_template text,      -- blank on follow-ups = reply in thread
  body_template text,         -- guidance for the drafter, or literal body
  ai_draft boolean not null default true,
  unique (campaign_id, position)
);

create table public.campaign_enrollments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  account_id uuid references public.accounts (id) on delete set null,
  status public.enrollment_status not null default 'active',
  current_step smallint not null default 0,
  next_send_at timestamptz,
  gmail_thread_id text,
  external_lead_id text,      -- Instantly lead id
  stopped_at timestamptz,
  stop_reason text,
  enrolled_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id)
);
create index campaign_enrollments_due_idx on public.campaign_enrollments (next_send_at)
  where status = 'active';
create trigger campaign_enrollments_touch before update on public.campaign_enrollments
  for each row execute function public.touch_updated_at();

create table public.campaign_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  enrollment_id uuid not null references public.campaign_enrollments (id) on delete cascade,
  step_position smallint not null,
  subject text,
  body text not null,
  status public.message_status not null default 'draft',
  mailbox_connection_id uuid references public.integration_connections (id) on delete set null,
  scheduled_for timestamptz,
  sent_at timestamptz,
  gmail_message_id text,
  gmail_thread_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (enrollment_id, step_position)
);
create index campaign_messages_mailbox_day_idx on public.campaign_messages (mailbox_connection_id, sent_at)
  where status = 'sent';
create trigger campaign_messages_touch before update on public.campaign_messages
  for each row execute function public.touch_updated_at();

-- Never email these addresses again from this workspace.
create table public.suppressions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email extensions.citext not null,
  reason text not null check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual')),
  source text,
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);
