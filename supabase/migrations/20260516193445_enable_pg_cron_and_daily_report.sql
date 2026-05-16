/*
  # Enable pg_cron and pg_net, schedule daily report at 19:00 BRT

  1. Extensions
    - Enable `pg_cron` for job scheduling
    - Enable `pg_net` for async HTTP calls from cron jobs

  2. Cron Job
    - Schedule `daily-gia-report` to call report-overdue-tasks edge function
    - Runs every day at 22:00 UTC (19:00 BRT)
    - Uses pg_net to make HTTP POST to the edge function
*/

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.schedule(
  'daily-gia-report',
  '0 22 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/report-overdue-tasks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.supabase_service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
