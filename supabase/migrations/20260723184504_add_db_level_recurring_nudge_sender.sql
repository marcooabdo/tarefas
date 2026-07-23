/*
# Create database-level recurring task sender via cron

## Problem
The nudge-overdue-tasks edge function updates last_ai_nudge but doesn't actually
call send-task-nudge for recurring tasks.

## Solution
Create a PL/pgSQL function that finds recurring tasks due now and calls
send-task-nudge for each via net.http_post. A dedicated cron job runs it.

## Changes
- Create function send_recurring_nudges()
- Create cron job recurring-nudges-every-5min
*/

CREATE OR REPLACE FUNCTION send_recurring_nudges()
RETURNS jsonb AS $$
DECLARE
  task_row RECORD;
  send_count INT := 0;
  base_url TEXT := 'https://rumghopkepljnlbioyll.supabase.co/functions/v1/send-task-nudge';
BEGIN
  FOR task_row IN
    SELECT id, task_code, recurrence, last_ai_nudge
    FROM tasks
    WHERE nudge_active = true
      AND status NOT IN ('completed', 'cancelled')
      AND first_nudge_at <= NOW()
      AND recurrence IS NOT NULL
      AND recurrence != 'none'
    ORDER BY first_nudge_at ASC
    LIMIT 50
  LOOP
    PERFORM net.http_post(
      url := base_url,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object('task_id', task_row.id)
    );
    
    UPDATE tasks 
    SET last_ai_nudge = NOW(),
        ai_interventions = COALESCE(ai_interventions, 0) + 1
    WHERE id = task_row.id;
    
    send_count := send_count + 1;
  END LOOP;
  
  RETURN jsonb_build_object('sent', send_count);
END;
$$ LANGUAGE plpgsql;

SELECT cron.schedule(
  'recurring-nudges-every-5min',
  '*/5 * * * *',
  $$SELECT send_recurring_nudges();$$
);