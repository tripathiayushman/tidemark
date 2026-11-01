-- Tidemark worker schedule (run once in the Supabase SQL editor AFTER the app
-- is deployed). Calls POST /api/worker/tick every minute with the CRON_SECRET.
-- Not a migration on purpose: it needs your deployed URL and secret.
--
-- 1. Store the secret and URL in Vault (replace the placeholders):
--      select vault.create_secret('<CRON_SECRET from your env>', 'tidemark_cron_secret');
--      select vault.create_secret('https://<your-app-domain>', 'tidemark_app_url');
-- 2. Then run the rest of this file.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('tidemark-worker') where exists (select 1 from cron.job where jobname = 'tidemark-worker');

select cron.schedule(
  'tidemark-worker',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'tidemark_app_url') || '/api/worker/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'tidemark_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Housekeeping: drop finished jobs and old schedule ledger rows weekly.
select cron.unschedule('tidemark-cleanup') where exists (select 1 from cron.job where jobname = 'tidemark-cleanup');
select cron.schedule(
  'tidemark-cleanup',
  '17 3 * * 0',
  $$
  delete from public.jobs where status in ('done', 'cancelled') and finished_at < now() - interval '14 days';
  delete from public.scheduled_runs where created_at < now() - interval '30 days';
  $$
);
