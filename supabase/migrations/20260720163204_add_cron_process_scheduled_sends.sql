/*
# Add cron for processing scheduled sends

1. Changes
   - Creates a cron job `process-scheduled-sends-every-5min` that calls
     the `process-scheduled-sends` edge function every 5 minutes.
   - This function checks for approved messages whose `scheduled_send_at`
     has arrived and sends them at the correct time.

2. Important notes
   - This fixes the bug where approving a scheduled message would send
     it immediately instead of waiting for the scheduled time.
*/

SELECT cron.schedule(
  'process-scheduled-sends-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rumghopkepljnlbioyll.supabase.co/functions/v1/process-scheduled-sends',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1bWdob3BrZXBsam5sYmlveWxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyOTYxMzgsImV4cCI6MjA5MTg3MjEzOH0.3Jtua9DH33t3O10OoKDvU0lr4IcY2_1V4Npzlrs_KV8"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
