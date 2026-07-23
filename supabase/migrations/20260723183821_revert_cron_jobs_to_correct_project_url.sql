/*
# Revert cron jobs back to correct project URL (rumghopkepljnlbioyll)

## Problem
The edge functions, database, and cron jobs all live on the rumghopkepljnlbioyll project.
The previous migration incorrectly changed URLs to dteslxvuadvozufhoqaq which is a 
different project (used by the MCP tooling, not by the actual app).

## Changes
- Revert all 3 cron jobs back to rumghopkepljnlbioyll.supabase.co
- Keep verify_jwt=false (no auth header needed)
*/

SELECT cron.unschedule('daily-gia-report');
SELECT cron.unschedule('nudge-overdue-tasks-every-5min');
SELECT cron.unschedule('process-scheduled-sends-every-5min');

SELECT cron.schedule(
  'daily-gia-report',
  '0 22 * * *',
  $$
  SELECT net.http_post(
    url := 'https://rumghopkepljnlbioyll.supabase.co/functions/v1/report-overdue-tasks',
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
    url := 'https://rumghopkepljnlbioyll.supabase.co/functions/v1/nudge-overdue-tasks',
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
    url := 'https://rumghopkepljnlbioyll.supabase.co/functions/v1/process-scheduled-sends',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);