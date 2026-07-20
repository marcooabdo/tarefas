/*
# Fix cron jobs for automatic task nudging and daily report

1. Changes
   - Drops the broken `daily-gia-report` cron job that used non-existent
     `app.settings.*` GUC parameters.
   - Recreates `daily-gia-report` with hardcoded Supabase URL and anon key.
   - Creates NEW `nudge-overdue-tasks-every-5min` cron job that calls the
     `nudge-overdue-tasks` edge function every 5 minutes. This is what
     actually checks for tasks whose `first_nudge_at` has arrived and sends
     the WhatsApp message.

2. Security
   - Uses the anon key (public) which is safe because both edge functions
     have `verifyJWT: false`.

3. Important notes
   - Without this cron, NO automatic nudges were being sent — tasks like
     ATOM-1049 were never triggered despite having correct `first_nudge_at`.
   - The daily report cron was also failing silently every day.
*/

-- Remove the broken job
SELECT cron.unschedule('daily-gia-report');

-- Recreate daily report (runs at 22:00 UTC = 19:00 BRT)
SELECT cron.schedule(
  'daily-gia-report',
  '0 22 * * *',
  $$
  SELECT net.http_post(
    url := 'https://rumghopkepljnlbioyll.supabase.co/functions/v1/report-overdue-tasks',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1bWdob3BrZXBsam5sYmlveWxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyOTYxMzgsImV4cCI6MjA5MTg3MjEzOH0.3Jtua9DH33t3O10OoKDvU0lr4IcY2_1V4Npzlrs_KV8"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- NEW: Check for overdue tasks every 5 minutes
SELECT cron.schedule(
  'nudge-overdue-tasks-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rumghopkepljnlbioyll.supabase.co/functions/v1/nudge-overdue-tasks',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1bWdob3BrZXBsam5sYmlveWxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyOTYxMzgsImV4cCI6MjA5MTg3MjEzOH0.3Jtua9DH33t3O10OoKDvU0lr4IcY2_1V4Npzlrs_KV8"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
