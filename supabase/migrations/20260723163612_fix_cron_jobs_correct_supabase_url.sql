/*
# Fix cron jobs to point to correct Supabase project URL

## Problem
The cron jobs were calling edge functions at `rumghopkepljnlbioyll.supabase.co` 
but the actual deployed functions are at `dteslxvuadvozufhoqaq.supabase.co`.
This caused all scheduled tasks (nudges, reports, scheduled sends) to fail silently.

## Changes
- Update `daily-gia-report` cron to call correct URL
- Update `nudge-overdue-tasks-every-5min` cron to call correct URL
- Update `process-scheduled-sends-every-5min` cron to call correct URL

## Notes
- All three edge functions have verify_jwt=false, so no Authorization header needed
- We still pass a minimal header for Content-Type
*/

-- Remove old cron jobs
SELECT cron.unschedule('daily-gia-report');
SELECT cron.unschedule('nudge-overdue-tasks-every-5min');
SELECT cron.unschedule('process-scheduled-sends-every-5min');

-- Re-create with correct URL
SELECT cron.schedule(
  'daily-gia-report',
  '0 22 * * *',
  $$
  SELECT net.http_post(
    url := 'https://dteslxvuadvozufhoqaq.supabase.co/functions/v1/report-overdue-tasks',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'nudge-overdue-tasks-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://dteslxvuadvozufhoqaq.supabase.co/functions/v1/nudge-overdue-tasks',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'process-scheduled-sends-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://dteslxvuadvozufhoqaq.supabase.co/functions/v1/process-scheduled-sends',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);