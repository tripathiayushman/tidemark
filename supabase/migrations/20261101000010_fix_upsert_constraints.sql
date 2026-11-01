-- Tidemark schema · part 10: upsert-friendly unique constraints
--
-- PostgREST upserts (ON CONFLICT (cols)) cannot target partial unique
-- indexes. NULLs are already distinct in ordinary unique constraints, so the
-- partial predicates were unnecessary — replace them with plain constraints.

drop index if exists public.signals_record_type_uidx;
alter table public.signals
  add constraint signals_record_type_key unique (source_record_id, signal_type);

drop index if exists public.contacts_ws_email_uidx;
alter table public.contacts
  add constraint contacts_ws_email_key unique (workspace_id, email);
